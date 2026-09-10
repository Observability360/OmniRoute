/**
 * O360 explicit-target-routing V1 — orchestration tests via the PUBLIC
 * handleComboChat entry point (same convention as combo-decision-trace.test.ts
 * and combo-target-timeout-standards.test.ts: real combo dispatch, injected
 * fake handleSingleModel — no private helpers, no real HTTP server, no real
 * provider credentials).
 *
 * Covers BOTH routing paths, checked in priority order by
 * tryExplicitTargetDispatch.ts:
 *   1. deterministic "/route <target>" (routeSlashCommand.ts) — always
 *      fails closed on an unresolved target.
 *   2. natural-language "use <alias>" (explicitTargetDetector.ts) —
 *      convenience path, falls through to ordinary chat when unresolved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-explicit-target-dispatch-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "explicit-target-dispatch-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { recordSessionModelUsage } = await import("../../../src/lib/db/contextHandoffs.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { resetComboTraceStore, getComboTrace, createInvocationId } =
  await import("../../../open-sse/services/combo/decisionTrace.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

function okResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// tryExplicitTargetDispatch reuses isPinnedModelDurablyUnhealthy (same health
// gate tryPinnedModelDispatch already applies to a context-cache pin) — a
// provider with ZERO active connections is durably unhealthy by design (no
// account can possibly serve it). "provider-b" is the resolved target for
// most explicit-alias tests below, so it needs one seeded active connection
// to be a realistic HEALTHY target, exactly like a real deployment would have
// before anyone could route to it. "cx" is seeded separately for the literal
// model-id tests (mirrors explicitTargetResolver.test.ts's own
// "cx/gpt-5.6-sol-high" example).
let seededProviderB = false;
async function ensureHealthyProviderB() {
  if (seededProviderB) return;
  await createProviderConnection({
    provider: "provider-b",
    authType: "apikey",
    name: "explicit-target-test-conn-b",
    apiKey: "sk-test",
    isActive: true,
    testStatus: "active",
  });
  seededProviderB = true;
}

// "cx" in "cx/gpt-5.6-sol-high" is a registered ALIAS for the real "codex"
// provider (resolveProviderAlias, open-sse/services/model.ts) — parseModel()
// resolves it before the health gate ever runs, so the seeded connection has
// to be for "codex", not the literal "cx" prefix (confirmed empirically: a
// "cx"-only seed left the health gate reporting durably unhealthy).
let seededProviderCodex = false;
async function ensureHealthyProviderCodex() {
  if (seededProviderCodex) return;
  await createProviderConnection({
    provider: "codex",
    authType: "apikey",
    name: "explicit-target-test-conn-codex",
    apiKey: "sk-test",
    isActive: true,
    testStatus: "active",
  });
  seededProviderCodex = true;
}

let seededProviderClaude = false;
async function ensureHealthyProviderClaude() {
  if (seededProviderClaude) return;
  await createProviderConnection({
    provider: "claude",
    authType: "apikey",
    name: "explicit-target-test-conn-claude",
    apiKey: "sk-test",
    isActive: true,
    testStatus: "active",
  });
  seededProviderClaude = true;
}

// Fallthrough tests dispatch to the COMBO's OWN normal-strategy candidate
// ("provider-a/model-a") once an unresolved explicit-target candidate falls
// through — that candidate selection also needs a real healthy connection,
// same as provider-b/codex above.
let seededProviderA = false;
async function ensureHealthyProviderA() {
  if (seededProviderA) return;
  await createProviderConnection({
    provider: "provider-a",
    authType: "apikey",
    name: "explicit-target-test-conn-a",
    apiKey: "sk-test",
    isActive: true,
    testStatus: "active",
  });
  seededProviderA = true;
}

test.beforeEach(async () => {
  resetComboTraceStore();
  await updateSettings({ explicitTargetAliases: {} });
  await ensureHealthyProviderA();
  await ensureHealthyProviderB();
  await ensureHealthyProviderCodex();
  await ensureHealthyProviderClaude();
});

// ═══════════════════════════════════════════════════════════════════════════
// Natural language — bare-model target, full messages passthrough
// ═══════════════════════════════════════════════════════════════════════════

test("bare-model explicit target: dispatches directly, full message history preserved", async () => {
  await updateSettings({ explicitTargetAliases: { astra: "provider-b/model-b" } });
  const calls: { modelStr: string; messages: unknown }[] = [];
  const messages = [
    { role: "user", content: "primeiro turno" },
    { role: "assistant", content: "resposta anterior" },
    { role: "user", content: "agora use Astra para criticar o que você fez" },
  ];

  const res = await handleComboChat({
    body: { messages },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (b: Record<string, unknown>, modelStr: string) => {
      calls.push({ modelStr, messages: b.messages });
      return okResponse("critique from astra");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].modelStr, "provider-b/model-b");
  assert.deepEqual(
    calls[0].messages,
    messages,
    "full conversation history must reach the resolved target unmodified"
  );
});

test("natural language: lowercase alias resolves identically to the capitalized form", async () => {
  await updateSettings({ explicitTargetAliases: { astra: "provider-b/model-b" } });
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "use astra para revisar" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("ok");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["provider-b/model-b"]);
});

test('natural language: "use Claude" resolves the real configured Claude target', async () => {
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "use Claude" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("ok");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["cc/claude-sonnet-5"]);
});

// ── combo target: full passthrough + exactly-one recursion guard ────────────

test("combo explicit target: recurses exactly once, full passthrough, no infinite loop", async () => {
  await updateSettings({ explicitTargetAliases: { astra: "combo/critic-combo" } });
  const calls: { modelStr: string; messages: unknown }[] = [];
  const messages = [
    { role: "user", content: "primeiro turno" },
    { role: "assistant", content: "resposta anterior" },
    { role: "user", content: "agora use Astra para criticar o que você fez" },
  ];
  const combos = [
    { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    { name: "critic-combo", strategy: "priority", models: ["provider-c/model-c"] },
  ];

  const res = await handleComboChat({
    body: { messages },
    combo: combos[0],
    handleSingleModel: async (b: Record<string, unknown>, modelStr: string) => {
      calls.push({ modelStr, messages: b.messages });
      return okResponse("critique from astra");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: combos,
  });

  assert.equal(res.status, 200);
  // Exactly one dispatch, to the critic combo's model — never main-combo's own
  // model, and never dispatched twice (which is what an unguarded recursive
  // re-detection of "use Astra" in the same message would cause).
  assert.equal(calls.length, 1, "explicit target must recurse exactly once, not loop");
  assert.equal(calls[0].modelStr, "provider-c/model-c");
  assert.deepEqual(calls[0].messages, messages);
});

// ═══════════════════════════════════════════════════════════════════════════
// Natural language — conservative: unresolved candidates fall through
// ═══════════════════════════════════════════════════════════════════════════

for (const phrase of [
  "Use combo fallback",
  "Use a tool to look something up",
  "manda a mensagem",
  "use FooModel para revisar",
]) {
  test(`natural language: unresolved candidate in "${phrase}" falls through to normal combo dispatch, never UNKNOWN_TARGET`, async () => {
    const calls: string[] = [];
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: phrase }] },
      combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
      handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
        calls.push(modelStr);
        return okResponse("normal combo response");
      },
      // false for any explicit-target candidate (proving it never resolves),
      // but true for the combo's OWN real model — this same callback also
      // gates the combo's normal-strategy candidate filtering, not just
      // explicit-target resolution.
      isModelAvailable: async (m: string) => m === "provider-a/model-a",
      log,
      settings: null,
      allCombos: null,
    });
    assert.equal(res.status, 200, `"${phrase}" must not hard-fail the request`);
    assert.deepEqual(
      calls,
      ["provider-a/model-a"],
      `"${phrase}" must fall through to the combo's own strategy`
    );
  });
}

test("natural language: never reaches tier-4 (literal model id) resolution, even when isModelAvailable would say yes", async () => {
  // Regression guard: a real production isModelAvailable (checkModelAvailable,
  // src/sse/handlers/chat.ts) does not reliably return false for a nonsense
  // string — it is written for a model id the CALLER already believes might
  // be real, not an arbitrary word extracted from ordinary prose. Feeding an
  // NL candidate into tier 4 let "Use combo fallback" resolve "combo" as a
  // literal (bogus) model id and dispatch to it — caught via a direct
  // production stack trace, not just this stub. Simulating that "yes" here
  // (isModelAvailable always true) proves NL still correctly ignores tier 4
  // and falls through, rather than relying on the stub happening to say no.
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Use combo fallback" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("normal combo response");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    calls,
    ["provider-a/model-a"],
    "natural language must never dispatch to a tier-4-resolved literal model id"
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Deterministic "/route <target>" — the ONLY path that fails closed on an
// unresolved target, and the only path that strips the routing directive
// from the forwarded task text.
// ═══════════════════════════════════════════════════════════════════════════

for (const target of ["claude", "Claude", "CLAUDE"]) {
  test(`/route: "${target}" resolves case-insensitively to its approved real model`, async () => {
    const calls: string[] = [];
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: `/route ${target}\nreview this` }] },
      combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
      handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
        calls.push(modelStr);
        return okResponse("ok");
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ["cc/claude-sonnet-5"]);
  });
}

test("/route: literal model id with '/' and '.' routes to the exact model", async () => {
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "/route cx/gpt-5.6-sol-high\nreview this" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("ok");
    },
    isModelAvailable: async (modelStr: string) => modelStr === "cx/gpt-5.6-sol-high",
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["cx/gpt-5.6-sol-high"]);
});

test("/route astra remains UNKNOWN_TARGET until GPT-6 is configured", async () => {
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "/route astra\nreview this" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("should not happen");
    },
    isModelAvailable: async () => false,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
  assert.match(JSON.stringify(await res.json()), /UNKNOWN_TARGET/);
});

test("/route glm resolves to the confirmed GLM model", async () => {
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "/route glm\nreview this" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("ok");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["zai/glm-4.7-flash"]);
});

test("/route: lowercase-hyphenated combo name routes to that combo, case-insensitively", async () => {
  const calls: string[] = [];
  const combos = [
    { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    { name: "o360-cheap-worker", strategy: "priority", models: ["provider-c/model-c"] },
  ];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "/route O360-CHEAP-WORKER\nreview this" }] },
    combo: combos[0],
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("ok");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: combos,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["provider-c/model-c"]);
});

test('/route: "o360-coding" resolves to the configured combo', async () => {
  const calls: string[] = [];
  const combos = [
    { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    { name: "o360-coding", strategy: "priority", models: ["provider-b/model-b"] },
  ];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "/route o360-coding\nreview this" }] },
    combo: combos[0],
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("ok");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: combos,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["provider-b/model-b"]);
});

test("/route: unknown target ALWAYS fails closed (deterministic syntax, no lower-confidence fallback)", async () => {
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "/route TotallyUnknown\nreview this" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("should not happen");
    },
    isModelAvailable: async () => false,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 400);
  assert.deepEqual(calls, [], "an unresolved /route target must never fall through");
  const body = await res.json();
  assert.match(JSON.stringify(body), /UNKNOWN_TARGET/);
});

test("/route: the control directive is stripped from the forwarded task text", async () => {
  await updateSettings({ explicitTargetAliases: { claude: "provider-b/model-b" } });
  let forwardedContent: unknown;
  const res = await handleComboChat({
    body: {
      messages: [
        { role: "user", content: "primeiro turno" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "/route claude Review this implementation for race conditions." },
      ],
    },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (b: Record<string, unknown>) => {
      const messages = b.messages as { role: string; content: unknown }[];
      forwardedContent = messages[messages.length - 1].content;
      return okResponse("ok");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200);
  assert.equal(
    forwardedContent,
    "Review this implementation for race conditions.",
    "the model must receive only the task text, not the raw /route control line"
  );
});

test("/route: earlier turns are never mutated, only the current turn's control line is removed", async () => {
  await updateSettings({ explicitTargetAliases: { claude: "provider-b/model-b" } });
  const earlierTurns = [
    { role: "user", content: "primeiro turno" },
    { role: "assistant", content: "resposta anterior" },
  ];
  let forwardedMessages: unknown;
  const res = await handleComboChat({
    body: {
      messages: [...earlierTurns, { role: "user", content: "/route claude\nreview this" }],
    },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (b: Record<string, unknown>) => {
      forwardedMessages = b.messages;
      return okResponse("ok");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200);
  const messages = forwardedMessages as { role: string; content: unknown }[];
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], earlierTurns[0]);
  assert.deepEqual(messages[1], earlierTurns[1]);
  assert.equal(messages[2].content, "review this");
});

test("/route: the command alone with no task content fails closed with MISSING_TASK", async () => {
  await updateSettings({ explicitTargetAliases: { claude: "provider-b/model-b" } });
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "/route claude" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("should not happen");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
  const body = await res.json();
  assert.match(JSON.stringify(body), /MISSING_TASK/);
});

test("/route: wrapped in a fenced code block does not route (falls through to normal combo dispatch)", async () => {
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "```\n/route claude\n```" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("ok");
    },
    isModelAvailable: async (m: string) => m === "provider-a/model-a",
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["provider-a/model-a"]);
});

test("/route: wrapped in inline code does not route (falls through to normal combo dispatch)", async () => {
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "`/route claude`" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("ok");
    },
    isModelAvailable: async (m: string) => m === "provider-a/model-a",
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["provider-a/model-a"]);
});

test("/route: in an earlier turn (not the last user message) does not route", async () => {
  await updateSettings({ explicitTargetAliases: { claude: "provider-b/model-b" } });
  const calls: string[] = [];
  const res = await handleComboChat({
    body: {
      messages: [
        { role: "user", content: "/route claude\nold instruction" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "corrija os pontos que encontrou" },
      ],
    },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("ok");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["provider-a/model-a"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Fail-closed paths shared by both routing sources
// ═══════════════════════════════════════════════════════════════════════════

test("ambiguous label across two combos: AMBIGUOUS_TARGET (409), no dispatch at all", async () => {
  const calls: string[] = [];
  const combos = [
    {
      name: "combo-a",
      strategy: "priority",
      models: [{ id: "s1", model: "provider-a/model-a", label: "Critic" }],
    },
    {
      name: "combo-b",
      strategy: "priority",
      models: [{ id: "s1", model: "provider-b/model-b", label: "Critic" }],
    },
  ];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "use Critic para revisar" }] },
    combo: combos[0],
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("should not happen");
    },
    isModelAvailable: async () => false,
    log,
    settings: null,
    allCombos: combos,
  });
  assert.equal(res.status, 409);
  assert.deepEqual(calls, []);
  const body = await res.json();
  assert.match(JSON.stringify(body), /AMBIGUOUS_TARGET/);
});

test("natural language: resolved-but-durably-unhealthy target: TARGET_UNAVAILABLE (503), no fallback to combo strategy", async () => {
  await updateSettings({
    explicitTargetAliases: { brokenalias: "totally-fake-provider-xyz/model-1" },
  });
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "use BrokenAlias para revisar" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("should not happen");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 503);
  assert.deepEqual(
    calls,
    [],
    "a durably unhealthy explicit target must fail closed, never fall through to the combo's own healthy candidate"
  );
  const body = await res.json();
  assert.match(JSON.stringify(body), /TARGET_UNAVAILABLE/);
});

test("/route: resolved-but-durably-unhealthy target: TARGET_UNAVAILABLE (503), no fallback to combo strategy", async () => {
  await updateSettings({
    explicitTargetAliases: { brokenalias: "totally-fake-provider-xyz/model-1" },
  });
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "/route BrokenAlias\nreview this" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("should not happen");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 503);
  assert.deepEqual(calls, []);
  const body = await res.json();
  assert.match(JSON.stringify(body), /TARGET_UNAVAILABLE/);
});

// ── explicit target beats an active context-cache/session pin ───────────────

test("natural language: explicit target overrides an active context-cache pin for the same session", async () => {
  await updateSettings({ explicitTargetAliases: { astra: "provider-b/model-b" } });
  recordSessionModelUsage("sess-pin-test", "main-combo", "provider-a/pinned-model", "provider-a");

  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "agora use Astra para criticar" }] },
    combo: {
      name: "main-combo",
      strategy: "priority",
      models: ["provider-a/pinned-model", "provider-a/model-a"],
      context_cache_protection: true,
    },
    relayOptions: { sessionId: "sess-pin-test" },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("critique");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(
    calls,
    ["provider-b/model-b"],
    "explicit target must win over the session's context-cache pin"
  );
});

test("/route: overrides an active context-cache pin for the same session", async () => {
  await updateSettings({ explicitTargetAliases: { claude: "provider-b/model-b" } });
  recordSessionModelUsage(
    "sess-pin-test-slash",
    "main-combo",
    "provider-a/pinned-model",
    "provider-a"
  );

  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "/route claude\ncritique this" }] },
    combo: {
      name: "main-combo",
      strategy: "priority",
      models: ["provider-a/pinned-model", "provider-a/model-a"],
      context_cache_protection: true,
    },
    relayOptions: { sessionId: "sess-pin-test-slash" },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("critique");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["provider-b/model-b"]);
});

test("explicit COMBO target beats an existing pin, and the old pin cannot reappear during the recursion", async () => {
  await updateSettings({ explicitTargetAliases: { astra: "combo/critic-combo" } });
  // A prior turn pinned main-combo to provider-a/model-a for this session.
  recordSessionModelUsage("sess-combo-pin-test", "main-combo", "provider-a/model-a", "provider-a");
  // critic-combo ALSO has context-cache protection on (the harder case): if
  // the recursion guard or session threading were wrong, this combo's own
  // phaseComboSetup could try to honor a pin too, and something might
  // resolve back to the old provider-a/model-a — it must not, both because
  // no pin was ever recorded for "critic-combo" specifically (pin history is
  // keyed by (session_id, combo_name)) and because explicit-target detection
  // is skipped on the recursed-into call (explicitTargetResolved=true), so it
  // can never re-resolve "Astra" and re-recurse either.
  const combos = [
    {
      name: "main-combo",
      strategy: "priority",
      models: ["provider-a/model-a"],
      context_cache_protection: true,
    },
    {
      name: "critic-combo",
      strategy: "priority",
      models: ["provider-c/model-c"],
      context_cache_protection: true,
    },
  ];

  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "use Astra para criticar" }] },
    combo: combos[0],
    relayOptions: { sessionId: "sess-combo-pin-test" },
    handleSingleModel: async (_b: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okResponse("critique");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: combos,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(
    calls,
    ["provider-c/model-c"],
    "critic-combo must dispatch to its OWN target — the old main-combo pin must never reappear during the recursion"
  );
});

// ── audit trail ───────────────────────────────────────────────────────────────

test("explicit override is recorded on the request's existing combo trace (no new audit subsystem)", async () => {
  await updateSettings({ explicitTargetAliases: { astra: "provider-b/model-b" } });
  const invocationId = createInvocationId();
  const res = await handleComboChat({
    invocationId,
    body: { messages: [{ role: "user", content: "use Astra para revisar" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async () => okResponse("ok"),
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200);
  const trace = getComboTrace(invocationId)!;
  const explicitDecisions = trace.decisions.filter((d) => d.step === "explicit_target");
  assert.equal(explicitDecisions.length, 1);
  assert.equal(explicitDecisions[0].decision, "explicit_override");
  assert.match(explicitDecisions[0].target, /astra/i);
  assert.match(explicitDecisions[0].target, /source=natural_language/);
});

test("/route: explicit override is recorded on the trace with source=slash_command", async () => {
  await updateSettings({ explicitTargetAliases: { claude: "provider-b/model-b" } });
  const invocationId = createInvocationId();
  const res = await handleComboChat({
    invocationId,
    body: { messages: [{ role: "user", content: "/route claude\nreview this" }] },
    combo: { name: "main-combo", strategy: "priority", models: ["provider-a/model-a"] },
    handleSingleModel: async () => okResponse("ok"),
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res.status, 200);
  const trace = getComboTrace(invocationId)!;
  const explicitDecisions = trace.decisions.filter((d) => d.step === "explicit_target");
  assert.equal(explicitDecisions.length, 1);
  assert.equal(explicitDecisions[0].decision, "explicit_override");
  assert.match(explicitDecisions[0].target, /source=slash_command/);
  assert.match(explicitDecisions[0].target, /claude/i);
});

// ── three-turn acceptance scenario ───────────────────────────────────────────

test("three-turn scenario: normal → explicit /route claude with full history → back to normal", async () => {
  await updateSettings({ explicitTargetAliases: { claude: "provider-b/model-b" } });
  const dispatched: { modelStr: string; messageCount: number }[] = [];
  const handleSingleModel = async (b: Record<string, unknown>, modelStr: string) => {
    const messages = (b.messages as unknown[]) ?? [];
    dispatched.push({ modelStr, messageCount: messages.length });
    if (modelStr === "provider-b/model-b") return okResponse("critique: found 2 issues");
    return okResponse(`implementation from ${modelStr}`);
  };
  const combo = { name: "o360-coding-sim", strategy: "priority", models: ["provider-a/codex"] };

  // TURN 1 — normal coding request, no explicit target.
  let messages: Record<string, unknown>[] = [{ role: "user", content: "implemente a função X" }];
  const res1 = await handleComboChat({
    body: { messages },
    combo,
    handleSingleModel,
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res1.status, 200);
  assert.equal(dispatched[0].modelStr, "provider-a/codex");
  messages = [...messages, { role: "assistant", content: "implementação da função X pronta" }];

  // TURN 2 — "/route claude\nreview the previous answer"; full prior history
  // must reach the resolved target, with only the current turn's control
  // line stripped.
  messages = [...messages, { role: "user", content: "/route claude\nreview the previous answer" }];
  const res2 = await handleComboChat({
    body: { messages },
    combo,
    handleSingleModel,
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res2.status, 200);
  assert.equal(dispatched[1].modelStr, "provider-b/model-b");
  assert.equal(
    dispatched[1].messageCount,
    messages.length,
    "turn 2 must carry the full prior history"
  );
  messages = [...messages, { role: "assistant", content: "critique: found 2 issues" }];

  // TURN 3 — back to normal, no explicit target: routing returns to the
  // combo's own candidate, not stuck on claude.
  messages = [...messages, { role: "user", content: "now improve it" }];
  const res3 = await handleComboChat({
    body: { messages },
    combo,
    handleSingleModel,
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res3.status, 200);
  assert.equal(
    dispatched[2].modelStr,
    "provider-a/codex",
    "turn 3 must route back to normal combo selection"
  );
  assert.equal(dispatched.length, 3);
});

test("three-turn scenario (natural language): normal → explicit Astra with full history → back to normal", async () => {
  await updateSettings({ explicitTargetAliases: { astra: "provider-b/model-b" } });
  const dispatched: { modelStr: string; messageCount: number }[] = [];
  const handleSingleModel = async (b: Record<string, unknown>, modelStr: string) => {
    const messages = (b.messages as unknown[]) ?? [];
    dispatched.push({ modelStr, messageCount: messages.length });
    if (modelStr === "provider-b/model-b") return okResponse("critique: found 2 issues");
    return okResponse(`implementation from ${modelStr}`);
  };
  const combo = { name: "o360-coding-sim", strategy: "priority", models: ["provider-a/codex"] };

  let messages: Record<string, unknown>[] = [{ role: "user", content: "implemente a função X" }];
  const res1 = await handleComboChat({
    body: { messages },
    combo,
    handleSingleModel,
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res1.status, 200);
  assert.equal(dispatched[0].modelStr, "provider-a/codex");
  messages = [...messages, { role: "assistant", content: "implementação da função X pronta" }];

  messages = [
    ...messages,
    { role: "user", content: "agora use Astra para criticar o que você fez" },
  ];
  const res2 = await handleComboChat({
    body: { messages },
    combo,
    handleSingleModel,
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res2.status, 200);
  assert.equal(dispatched[1].modelStr, "provider-b/model-b");
  assert.equal(dispatched[1].messageCount, messages.length);
  messages = [...messages, { role: "assistant", content: "critique: found 2 issues" }];

  messages = [...messages, { role: "user", content: "agora corrija os pontos que encontrou" }];
  const res3 = await handleComboChat({
    body: { messages },
    combo,
    handleSingleModel,
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });
  assert.equal(res3.status, 200);
  assert.equal(dispatched[2].modelStr, "provider-a/codex");
  assert.equal(dispatched.length, 3);
});
