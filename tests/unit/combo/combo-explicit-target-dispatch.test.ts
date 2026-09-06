/**
 * O360 explicit-target-routing V1 — orchestration tests via the PUBLIC
 * handleComboChat entry point (same convention as combo-decision-trace.test.ts
 * and combo-target-timeout-standards.test.ts: real combo dispatch, injected
 * fake handleSingleModel — no private helpers, no real HTTP server, no real
 * provider credentials).
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
// every explicit-alias test below, so it needs one seeded active connection
// to be a realistic HEALTHY target, exactly like a real deployment would have
// before anyone could route to it.
let seededProviderB = false;
async function ensureHealthyProviderB() {
  if (seededProviderB) return;
  await createProviderConnection({
    provider: "provider-b",
    authType: "apikey",
    name: "explicit-target-test-conn",
    apiKey: "sk-test",
    isActive: true,
    testStatus: "active",
  });
  seededProviderB = true;
}

test.beforeEach(async () => {
  resetComboTraceStore();
  await updateSettings({ explicitTargetAliases: {} });
  await ensureHealthyProviderB();
});

// ── bare-model target: full messages passthrough ─────────────────────────────

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

// ── fail-closed paths: never a silent fallback to the combo's own strategy ───

test("unknown alias: UNKNOWN_TARGET (400), normal combo model never dispatched", async () => {
  const calls: string[] = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "use FooModel para revisar" }] },
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
  assert.deepEqual(
    calls,
    [],
    "an unresolved explicit target must never fall through to the combo's own strategy"
  );
  const body = await res.json();
  assert.match(JSON.stringify(body), /UNKNOWN_TARGET/);
});

test("ambiguous label across two combos: AMBIGUOUS_TARGET (409), no dispatch at all", async () => {
  const calls: string[] = [];
  const combos = [
    {
      name: "combo-a",
      strategy: "priority",
      models: [{ id: "s1", model: "provider-a/model-a", label: "Astra" }],
    },
    {
      name: "combo-b",
      strategy: "priority",
      models: [{ id: "s1", model: "provider-b/model-b", label: "Astra" }],
    },
  ];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "use Astra para revisar" }] },
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

test("resolved-but-durably-unhealthy target: TARGET_UNAVAILABLE (503), no fallback to combo strategy", async () => {
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

// ── explicit target beats an active context-cache/session pin ───────────────

test("explicit target overrides an active context-cache pin for the same session", async () => {
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
});

// ── three-turn acceptance scenario ───────────────────────────────────────────

test("three-turn scenario: normal → explicit Astra with full history → back to normal", async () => {
  await updateSettings({ explicitTargetAliases: { astra: "provider-b/model-b" } });
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

  // TURN 2 — explicit Astra request; full history (both prior turns) must
  // reach the resolved target unmodified.
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
  assert.equal(
    dispatched[1].messageCount,
    messages.length,
    "turn 2 must carry the full prior history"
  );
  messages = [...messages, { role: "assistant", content: "critique: found 2 issues" }];

  // TURN 3 — back to normal, no explicit target: routing returns to the
  // combo's own candidate, not stuck on Astra.
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
  assert.equal(
    dispatched[2].modelStr,
    "provider-a/codex",
    "turn 3 must route back to normal combo selection"
  );
  assert.equal(dispatched.length, 3);
});
