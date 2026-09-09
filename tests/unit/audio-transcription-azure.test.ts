// O360 STT V1 — Azure AI Speech (Fast Transcription API) provider tests.
import test from "node:test";
import assert from "node:assert/strict";

const { handleAudioTranscription, AZURE_PHRASE_HINTS } =
  await import("../../open-sse/handlers/audioTranscription.ts");

function buildFile(contents: string, name: string, type: string) {
  return new File([Buffer.from(contents)], name, { type });
}

function azureCredentials(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: "sk-azure-test-key",
    providerSpecificData: { region: "eastus" },
    ...overrides,
  };
}

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

test("handleAudioTranscription (azure): successful transcription — request shape, auth header, phrase hints, response normalization", async () => {
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
    formData.append("file", buildFile("fake-audio-bytes", "clip.webm", "audio/webm;codecs=opus"));
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
    assert.ok(bodyText.includes('name="definition"'));
    assert.ok(bodyText.includes('"locales":["pt-BR"]'));
    for (const phrase of AZURE_PHRASE_HINTS) {
      assert.ok(bodyText.includes(phrase), `definition must include phrase hint "${phrase}"`);
    }
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
    formData.append("file", buildFile("abc", "clip.webm", "audio/webm;codecs=opus"));

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
    formData.append("file", buildFile("abc", "clip.webm", "audio/webm;codecs=opus"));

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
    formData.append("file", buildFile("abc", "clip.webm", "audio/webm;codecs=opus"));

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
    formData.append("file", buildFile("abc", "clip.webm", "audio/webm;codecs=opus"));

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
    formData.append("file", buildFile("abc", "clip.webm", "audio/webm;codecs=opus"));

    const response = await handleAudioTranscription({ formData, credentials: azureCredentials() });
    assert.equal(response.status, 504);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
