import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type NormalizeResult = { bytes: Uint8Array } | { error: string };
type NormalizeOptions = { timeoutMs?: number; maxOutputBytes?: number };
type ResolveResult = (result: NormalizeResult) => void;

type TranscodeState = {
  settled: boolean;
  timedOut: boolean;
  overflowed: boolean;
  outChunks: Buffer[];
  outLen: number;
  stderrTail: string;
  timer: ReturnType<typeof setTimeout>;
};

const AZURE_MAI_NATIVE_MIME_PREFIXES = ["audio/wav", "audio/mpeg", "audio/flac"];
const FFMPEG_TIMEOUT_MS = 15_000;
const FFMPEG_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const FFMPEG_ARGS = [
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  "pipe:0",
  "-map",
  "0:a:0",
  "-vn",
  "-ac",
  "1",
  "-ar",
  "16000",
  "-c:a",
  "pcm_s16le",
  "-f",
  "wav",
  "pipe:1",
];

export function isAzureMaiNativeMime(mimeType: string): boolean {
  return AZURE_MAI_NATIVE_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

function startError(err: unknown): string {
  return `ffmpeg failed to start: ${err instanceof Error ? err.message : String(err)}`;
}

function createSettler(state: TranscodeState, resolve: ResolveResult): ResolveResult {
  return (result) => {
    if (state.settled) return;
    state.settled = true;
    clearTimeout(state.timer);
    resolve(result);
  };
}

function collectStdout(
  proc: ChildProcessWithoutNullStreams,
  state: TranscodeState,
  maxOutputBytes: number
): (chunk: Buffer) => void {
  return (chunk) => {
    if (state.overflowed || state.settled) return;
    state.outLen += chunk.length;
    if (state.outLen > maxOutputBytes) {
      state.overflowed = true;
      proc.kill("SIGKILL");
      return;
    }
    state.outChunks.push(chunk);
  };
}

function collectStderr(state: TranscodeState): (chunk: Buffer) => void {
  return (chunk) => {
    if (state.stderrTail.length >= 2000) return;
    state.stderrTail += chunk.toString("utf8").slice(0, 2000 - state.stderrTail.length);
  };
}

function closeResult(state: TranscodeState, code: number | null, maxOutputBytes: number): NormalizeResult {
  if (state.overflowed) {
    return { error: `ffmpeg output exceeded ${maxOutputBytes} bytes and was terminated` };
  }
  if (state.timedOut) {
    return { error: "ffmpeg transcoding timed out and was terminated" };
  }
  if (code !== 0) {
    return { error: `ffmpeg exited with code ${code}${state.stderrTail ? `: ${state.stderrTail}` : ""}` };
  }
  return { bytes: Buffer.concat(state.outChunks, state.outLen) };
}

/**
 * Convert browser/container audio to 16 kHz mono PCM WAV through bounded
 * stdin/stdout pipes. No shell, temporary files, persisted audio, or audio logs.
 */
export async function normalizeForAzureMai(
  input: Uint8Array,
  opts: NormalizeOptions = {}
): Promise<NormalizeResult> {
  const timeoutMs = opts.timeoutMs ?? FFMPEG_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? FFMPEG_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn("ffmpeg", FFMPEG_ARGS, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ error: startError(err) });
      return;
    }

    const state: TranscodeState = {
      settled: false,
      timedOut: false,
      overflowed: false,
      outChunks: [],
      outLen: 0,
      stderrTail: "",
      timer: setTimeout(() => {
        state.timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs),
    };
    const settle = createSettler(state, resolve);
    proc.stdout.on("data", collectStdout(proc, state, maxOutputBytes));
    proc.stderr.on("data", collectStderr(state));
    proc.on("error", (err) => settle({ error: startError(err) }));
    proc.stdin.on("error", () => undefined);
    proc.on("close", (code) => settle(closeResult(state, code, maxOutputBytes)));
    proc.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  });
}
