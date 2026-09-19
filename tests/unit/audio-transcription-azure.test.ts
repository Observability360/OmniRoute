// O360 STT V1 — Azure AI Speech (Fast Transcription API) provider tests.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const { handleAudioTranscription, AZURE_PHRASE_HINTS, normalizeForAzureMai } = await import(
  "../../open-sse/handlers/audioTranscription.ts"
);

function buildFile(contents: string | Uint8Array, name: string, type: string) {
  const bytes = typeof contents === "string" ? Buffer.from(contents) : contents;
  return new File([bytes], name, { type });
}

function azureCredentials(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: "sk-azure-test-key",
    providerSpecificData: { region: "eastus" },
    ...overrides,
  };
}

/**
 * Synthesize a tiny real audio fixture (a 0.5s 440Hz sine tone, no
 * pre-recorded speech needed — these tests verify transcode-path mechanics
 * and multipart shape, not transcript correctness, which real spoken audio
 * already covers via the pre-merge production validation) in the given
 * container/codec via a real ffmpeg process. Uses ffmpeg's own `lavfi` test
 * source, so it needs no input file/fixture at all.
 */
function synthesizeAudio(muxerArgs: string[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.5",
      ...muxerArgs,
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`fixture ffmpeg exited ${code}: ${stderr}`));
        return;
      }
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
  });
}

let webmFixture: Uint8Array;
let oggFixture: Uint8Array;
let mp4Fixture: Uint8Array;

before(async () => {
  [webmFixture, oggFixture, mp4Fixture] = await Promise.all([
    synthesizeAudio(["-c:a", "libopus", "-f", "webm"]),
    synthesizeAudio(["-c:a", "libopus", "-f", "ogg"]),
    synthesizeAudio(["-c:a", "aac", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4"]),
  ]);
});

test("handleAudioTranscription (azure): missing credentials fails closed with 401", async () => {
  const formData = new FormData();
  formData.append("model", "azure/fast-transcription");
  formData.append("file", buildFile("abc", "clip.webm", "audio/webm;codecs=opus"));

  const response = await handleAudioTranscription({ formData, credentials: null });
  assert.equal(response.status, 401);
});

test("handleAudioTranscription (azure): missing region fails closed with 400, no secret leakage", async () => {
  const formData = new FormData();
  formData.append("model", "azure/fast-transcription");
  formData.append("file", buildFile("abc", "clip.webm", "audio/webm;codecs=opus"));

  const response = await handleAudioTranscription({
    formData,
    credentials: { apiKey: "sk-super-secret-azure-key" },
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.ok(!JSON.stringify(body).includes("sk-super-secret-azure-key"));
});

test("handleAudioTranscription (azure): rejects an unsupported MIME type before ever reaching Azure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("must not reach Azure for an unsupported content type");
  };
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile("not audio", "note.txt", "text/plain"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    assert.equal(response.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription (azure): rejects an oversized upload before ever reaching Azure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("must not reach Azure for an oversized upload");
  };
  try {
    const oversized = "a".repeat(26 * 1024 * 1024); // over the 25 MiB cap
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile(oversized, "clip.webm", "audio/webm;codecs=opus"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    assert.equal(response.status, 413);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// A/B/C: MAI-native formats (MP3, WAV, FLAC) pass through unchanged — no
// transcoding, original bytes reach Azure.
// ---------------------------------------------------------------------------

test("handleAudioTranscription (azure): MP3 — no transcoding, original bytes + filename reach Azure unchanged; request shape, auth header, phrase hints, response normalization", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url?: string; headers?: Record<string, string>; body?: Uint8Array } = {};

  globalThis.fetch = async (url, options: RequestInit = {}) => {
    captured = {
      url: String(url),
      headers: options.headers as Record<string, string>,
      body: options.body as Uint8Array,
    };
    return new Response(
      JSON.stringify({
        durationMilliseconds: 4200,
        combinedPhrases: [{ text: "reduza a cardinalidade das métricas do Prometheus" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile("fake-mp3-bytes", "clip.mp3", "audio/mpeg"));
    formData.append("language", "pt-BR");

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, { text: "reduza a cardinalidade das métricas do Prometheus" });

    assert.equal(
      captured.url,
      "https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15"
    );
    assert.equal(captured.headers?.["Ocp-Apim-Subscription-Key"], "sk-azure-test-key");
    assert.match(captured.headers?.["Content-Type"] ?? "", /^multipart\/form-data; boundary=/);

    const bodyText = new TextDecoder().decode(captured.body);
    assert.ok(
      bodyText.includes('name="audio"'),
      "file field must be named 'audio', not 'file' (Whisper's name)"
    );
    assert.ok(bodyText.includes('filename="clip.mp3"'), "MP3 is MAI-native: original filename must pass through unchanged");
    assert.ok(bodyText.includes("Content-Type: audio/mpeg"), "MP3 is MAI-native: original Content-Type must pass through unchanged");
    assert.ok(bodyText.includes("fake-mp3-bytes"), "MP3 is MAI-native: original bytes must pass through unchanged, not transcoded");
    assert.ok(bodyText.includes('name="definition"'));
    assert.ok(bodyText.includes('"locales":["pt-BR"]'));
    assert.ok(
      bodyText.includes('"enhancedMode":{"enabled":true,"model":"MAI-Transcribe-2"}'),
      "definition must request the MAI-Transcribe-2 enhanced mode"
    );
    assert.ok(
      !bodyText.includes("biasingWeight"),
      "biasingWeight must not be sent — proven a no-op on this REST endpoint"
    );
    for (const phrase of AZURE_PHRASE_HINTS) {
      assert.ok(bodyText.includes(phrase), `definition must include phrase hint "${phrase}"`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription (azure): WAV — no transcoding, original bytes + filename reach Azure unchanged", async () => {
  const originalFetch = globalThis.fetch;
  let bodyText = "";
  globalThis.fetch = async (_url, options: RequestInit = {}) => {
    bodyText = new TextDecoder().decode(options.body as Uint8Array);
    return new Response(JSON.stringify({ combinedPhrases: [{ text: "ok" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile("fake-wav-bytes", "clip.wav", "audio/wav"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    assert.equal(response.status, 200);
    assert.ok(bodyText.includes('filename="clip.wav"'));
    assert.ok(bodyText.includes("Content-Type: audio/wav"));
    assert.ok(bodyText.includes("fake-wav-bytes"), "WAV is MAI-native: original bytes must pass through unchanged");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription (azure): FLAC — no transcoding, original bytes + filename reach Azure unchanged", async () => {
  const originalFetch = globalThis.fetch;
  let bodyText = "";
  globalThis.fetch = async (_url, options: RequestInit = {}) => {
    bodyText = new TextDecoder().decode(options.body as Uint8Array);
    return new Response(JSON.stringify({ combinedPhrases: [{ text: "ok" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile("fake-flac-bytes", "clip.flac", "audio/flac"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    assert.equal(response.status, 200);
    assert.ok(bodyText.includes('filename="clip.flac"'));
    assert.ok(bodyText.includes("Content-Type: audio/flac"));
    assert.ok(bodyText.includes("fake-flac-bytes"), "FLAC is MAI-native: original bytes must pass through unchanged");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// D/E: browser/container formats (WebM, OGG, MP4) select the transcoding
// path — real ffmpeg, real decodable fixtures, real WAV output reaching
// Azure with filename=audio.wav / Content-Type=audio/wav.
// ---------------------------------------------------------------------------

test("handleAudioTranscription (azure): WebM/Opus — transcoding path selected, resulting Azure upload is filename=audio.wav Content-Type=audio/wav real WAV bytes", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { headers?: Record<string, string>; body?: Uint8Array } = {};
  globalThis.fetch = async (_url, options: RequestInit = {}) => {
    captured = { headers: options.headers as Record<string, string>, body: options.body as Uint8Array };
    return new Response(JSON.stringify({ combinedPhrases: [{ text: "ok" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile(webmFixture, "clip.webm", "audio/webm;codecs=opus"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    assert.equal(response.status, 200);

    const bodyBytes = captured.body as Uint8Array;
    const bodyText = new TextDecoder("latin1").decode(bodyBytes);
    assert.ok(bodyText.includes('filename="audio.wav"'), "webm must be re-filenamed to audio.wav");
    assert.ok(bodyText.includes("Content-Type: audio/wav"), "webm must be re-typed to audio/wav");
    assert.ok(!bodyText.includes("Content-Type: audio/webm"), "the original webm Content-Type must not reach Azure");

    // Find the file part's bytes and confirm it's a real RIFF/WAVE stream,
    // not the raw webm bytes passed through untouched.
    const riffIndex = bodyText.indexOf("RIFF");
    assert.ok(riffIndex > -1, "transcoded output must be a real WAV (RIFF header)");
    assert.ok(bodyText.slice(riffIndex, riffIndex + 12).includes("WAVE"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription (azure): OGG/Opus — transcoding path selected at the public OmniRoute boundary", async () => {
  const originalFetch = globalThis.fetch;
  let bodyText = "";
  globalThis.fetch = async (_url, options: RequestInit = {}) => {
    bodyText = new TextDecoder("latin1").decode(options.body as Uint8Array);
    return new Response(JSON.stringify({ combinedPhrases: [{ text: "ok" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile(oggFixture, "clip.ogg", "audio/ogg;codecs=opus"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    assert.equal(response.status, 200);
    assert.ok(bodyText.includes('filename="audio.wav"'));
    assert.ok(bodyText.includes("Content-Type: audio/wav"));
    assert.ok(bodyText.includes("RIFF"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription (azure): MP4/AAC — transcoding path selected at the public OmniRoute boundary", async () => {
  const originalFetch = globalThis.fetch;
  let bodyText = "";
  globalThis.fetch = async (_url, options: RequestInit = {}) => {
    bodyText = new TextDecoder("latin1").decode(options.body as Uint8Array);
    return new Response(JSON.stringify({ combinedPhrases: [{ text: "ok" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile(mp4Fixture, "clip.mp4", "audio/mp4"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    assert.equal(response.status, 200);
    assert.ok(bodyText.includes('filename="audio.wav"'));
    assert.ok(bodyText.includes("Content-Type: audio/wav"));
    assert.ok(bodyText.includes("RIFF"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// F/G/H: bounded, clean failure handling in the transcode step itself —
// undecodable input, timeout, output-size overflow. All real ffmpeg, no
// mocking of the transcode mechanism.
// ---------------------------------------------------------------------------

test("handleAudioTranscription (azure): undecodable webm bytes -> clean bounded 422, zero Azure request", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("must not reach Azure when ffmpeg cannot decode the input");
  };
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile("this is not audio at all", "clip.webm", "audio/webm;codecs=opus"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    const body = await response.json();

    assert.equal(response.status, 422);
    assert.ok(!fetchCalled, "Azure must never be called when transcoding fails");
    assert.ok(typeof body.error?.message === "string" && body.error.message.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeForAzureMai: real ffmpeg timeout -> clean bounded error, process killed", async () => {
  // A 1ms budget cannot possibly let a real ffmpeg process start, decode,
  // and encode — deterministically exercises the real SIGKILL timeout path
  // without waiting out (or approximating) the production 15s duration.
  const result = await normalizeForAzureMai(webmFixture, { timeoutMs: 1 });
  assert.ok("error" in result, "must fail closed, not hang or throw");
  assert.match((result as { error: string }).error, /timed out/i);
});

test("normalizeForAzureMai: real output-size overflow -> clean bounded error, process killed", async () => {
  // A 100-byte cap is smaller than even a bare WAV header (44 bytes) plus
  // any real PCM data — deterministically exercises the real SIGKILL
  // overflow path with genuine decodable audio.
  const result = await normalizeForAzureMai(webmFixture, { maxOutputBytes: 100 });
  assert.ok("error" in result, "must fail closed, not return truncated/partial audio");
  assert.match((result as { error: string }).error, /exceeded/i);
});

// ---------------------------------------------------------------------------
// I: existing Azure auth/region/phraseList/MAI behavior unchanged (all
// exercised on a MAI-native fixture so no transcoding masks the assertion).
// ---------------------------------------------------------------------------

test("handleAudioTranscription (azure): normalizes the MAI-Transcribe-2 response shape (no word timestamps, single combined phrase) to { text }", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    // Real shape captured from a live MAI-Transcribe-2 call: no per-word
    // timestamps, a single combinedPhrases/phrases entry, locale "gl" and
    // confidence 0 (this backend doesn't populate those the way the
    // baseline model does) — combinedPhrases is still present, so no
    // MAI-specific branching is needed in the parser.
    new Response(
      JSON.stringify({
        durationMilliseconds: 11500,
        combinedPhrases: [
          {
            text: "Valide o traceparent, o SpanId e o TraceId antes de correlacionar logs, métricas e traces no HyperDX.",
          },
        ],
        phrases: [
          {
            offsetMilliseconds: 0,
            durationMilliseconds: 11500,
            text: "Valide o traceparent, o SpanId e o TraceId antes de correlacionar logs, métricas e traces no HyperDX.",
            locale: "gl",
            confidence: 0,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile("abc", "clip.mp3", "audio/mpeg"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      text: "Valide o traceparent, o SpanId e o TraceId antes de correlacionar logs, métricas e traces no HyperDX.",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription (azure): defaults locale to pt-BR when the caller does not specify a language", async () => {
  const originalFetch = globalThis.fetch;
  let bodyText = "";
  globalThis.fetch = async (_url, options: RequestInit = {}) => {
    bodyText = new TextDecoder().decode(options.body as Uint8Array);
    return new Response(JSON.stringify({ combinedPhrases: [{ text: "ok" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile("abc", "clip.mp3", "audio/mpeg"));

    await handleAudioTranscription({ formData, credentials: azureCredentials() });
    assert.ok(bodyText.includes('"locales":["pt-BR"]'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription (azure): propagates an Azure error response, no secret leakage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Invalid Ocp-Apim-Subscription-Key" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile("abc", "clip.mp3", "audio/mpeg"));

    const response = await handleAudioTranscription({
      formData,
      credentials: azureCredentials({ apiKey: "sk-real-secret-value" }),
    });
    const body = await response.json();

    assert.notEqual(response.status, 200);
    assert.ok(!JSON.stringify(body).includes("sk-real-secret-value"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription (azure): a malformed (non-JSON) Azure response fails closed with 502, not a crash", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<html>not json</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile("abc", "clip.mp3", "audio/mpeg"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    assert.equal(response.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription (azure): a JSON response missing combinedPhrases fails closed with 502", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ unexpected: "shape" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile("abc", "clip.mp3", "audio/mpeg"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    assert.equal(response.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription (azure): an Azure request timeout fails closed with 504", async () => {
  const originalFetch = globalThis.fetch;
  // Simulates what AbortSignal.timeout() causes fetch to reject with — a
  // DOMException/Error named "TimeoutError" — without waiting for the real
  // production timeout duration to actually elapse.
  globalThis.fetch = async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  };
  try {
    const formData = new FormData();
    formData.append("model", "azure/fast-transcription");
    formData.append("file", buildFile("abc", "clip.mp3", "audio/mpeg"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    assert.equal(response.status, 504);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
