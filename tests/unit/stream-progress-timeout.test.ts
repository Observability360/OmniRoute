import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A stream that stays open after readiness but stops producing model output
// (keepalives only) must be cut off by STREAM_PROGRESS_TIMEOUT_MS instead of
// hanging until the byte-level STREAM_IDLE_TIMEOUT_MS / executor wall-clock cap.
// The watchdog polls every 10s, so these tests take ~10s each.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-progress-timeout-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.STREAM_PROGRESS_TIMEOUT_MS = "1000";
process.env.STREAM_IDLE_TIMEOUT_MS = "600000";
const core = await import("../../src/lib/db/core.ts");
const { createSSEStream } = await import("../../open-sse/utils/stream.ts");
const { STREAM_PROGRESS_TIMEOUT_MS } = await import("../../open-sse/config/constants.ts");

const enc = new TextEncoder();
const chunk = (content: string) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-progress",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
const ping = `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`;

function pumpedSource(every: number, next: (i: number) => string | null) {
  let timer: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    start(c) {
      let i = 0;
      c.enqueue(enc.encode(chunk("hello")));
      timer = setInterval(() => {
        const out = next(i++);
        if (out === null) {
          clearInterval(timer);
          c.close();
          return;
        }
        c.enqueue(enc.encode(out));
      }, every);
    },
    cancel() {
      clearInterval(timer);
    },
  });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("STREAM_PROGRESS_TIMEOUT_MS is read from the environment", () => {
  assert.equal(STREAM_PROGRESS_TIMEOUT_MS, 1000);
});

test("keepalive-only stream after initial output fails with stream_progress_timeout", async () => {
  let failure: Record<string, unknown> | null = null;
  const source = pumpedSource(200, () => ping);
  const stream = source.pipeThrough(
    createSSEStream({
      provider: "test",
      model: "m",
      onFailure: (p: Record<string, unknown>) => {
        failure = p;
      },
    } as any)
  );
  await assert.rejects(new Response(stream).text(), /Progress timeout: no model output/);
  assert.equal(failure?.["code"], "stream_progress_timeout");
});

test("steady model output is not cut off by the progress watchdog", async () => {
  const source = pumpedSource(200, (i) => (i < 60 ? chunk(`t${i}`) : null));
  const text = await new Response(
    source.pipeThrough(createSSEStream({ provider: "test", model: "m" } as any))
  ).text();
  assert.match(text, /t59/);
});
