/**
 * Context-aware target eligibility (BUG_C follow-up).
 *
 * Before this change, combo.ts tried EVERY target in priority order even
 * when a target's own (known) context window could not possibly fit the
 * request -- producing a real network round-trip that always ended in a
 * 400 context_length_exceeded, wasting a hedge/fallback slot and time.
 *
 * These tests exercise handleComboChat (the real production entrypoint,
 * not a reimplementation) with a fake handleSingleModel that COUNTS calls
 * per model, so "network_calls=0 for the ineligible target" is asserted
 * directly rather than inferred from timing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ctx-eligibility-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "ctx-eligibility-test-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// ~4 chars/token (contextManager.ts CHARS_PER_TOKEN) -> this many chars
// estimates to roughly the given token count.
const charsForTokens = (tokens: number) => "x".repeat(tokens * 4);

function makeCombo(models: string[]) {
  return {
    name: "test-ctx-combo",
    strategy: "priority",
    models: models.map((m) => ({ model: m })),
  };
}

// T1: target1 (cursor, known 200k limit via registry default) cannot fit an
// estimated ~235k-token request; target2 (a model with no special-cased small
// limit, e.g. a generic large-context provider) can. Expected: target1 gets
// ZERO network calls, target2 is called and succeeds.
test("T1: an oversized request skips the too-small target with zero network calls, then succeeds on the next", async () => {
  const callsByModel: Record<string, number> = {};
  const handleSingleModel = async (_body: unknown, modelStr: string) => {
    callsByModel[modelStr] = (callsByModel[modelStr] ?? 0) + 1;
    return okResponse(`ok:${modelStr}`);
  };

  const result = await handleComboChat({
    body: {
      model: "test",
      messages: [{ role: "user", content: charsForTokens(235_000) }],
    },
    combo: makeCombo(["cursor/auto-balance", "cc/claude-sonnet-5"]),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(
    callsByModel["cursor/auto-balance"] ?? 0,
    0,
    "the too-small target must receive ZERO network calls"
  );
  assert.equal(callsByModel["cc/claude-sonnet-5"] ?? 0, 1, "the fitting target must be called");
  assert.equal(result.status, 200);
});

// T2: request fits comfortably in every target. Expected: dispatch order is
// completely unaffected -- the first target in priority order is called,
// nothing is skipped for context reasons.
test("T2: a request that fits every target preserves the original dispatch order exactly", async () => {
  const callOrder: string[] = [];
  const handleSingleModel = async (_body: unknown, modelStr: string) => {
    callOrder.push(modelStr);
    return okResponse(`ok:${modelStr}`);
  };

  const result = await handleComboChat({
    body: { model: "test", messages: [{ role: "user", content: "small request" }] },
    combo: makeCombo(["cursor/auto-balance", "cc/claude-sonnet-5", "zai/glm-5.3-flash-high"]),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.deepEqual(callOrder, ["cursor/auto-balance"], "only the first target should be tried, unaffected by the eligibility filter");
  assert.equal(result.status, 200);
});

// T3: request exceeds every target's known limit. Expected: NO network call
// is ever made (never a "known-bad" dispatch just to obtain a 400), and the
// terminal response is a structured, non-empty diagnostic.
test("T3: a request exceeding every target's known limit makes zero dispatches and returns a structured error", async () => {
  let callCount = 0;
  const handleSingleModel = async () => {
    callCount++;
    return okResponse("should never be called");
  };

  const result = await handleComboChat({
    body: {
      model: "test",
      messages: [{ role: "user", content: charsForTokens(50_000_000) }],
    },
    combo: makeCombo(["cursor/auto-balance", "cc/claude-sonnet-5"]),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(callCount, 0, "no target should ever be dispatched when all are known-insufficient");
  assert.equal(result.status, 400);
  const body = (await result.json()) as {
    error?: { code?: string; message?: string };
    diagnostics?: { terminalReason?: string; excluded?: unknown[] };
  };
  assert.equal(body.diagnostics?.terminalReason, "context_window_exceeded");
  assert.ok(Array.isArray(body.diagnostics?.excluded) && body.diagnostics!.excluded!.length > 0);
  assert.ok(
    (body.error?.message?.length ?? 0) > 20,
    "the error body must carry real diagnostics, never an empty envelope"
  );
});

// T4: a target whose provider/model the limit resolver has no specific
// knowledge of (falls through to the generic catch-all) must NEVER be
// dropped by the eligibility filter, regardless of how large the request
// estimate is -- fail-open on low-confidence limits.
test("T4: a target with an unresolvable/unknown context limit is never dropped, even for a huge request", async () => {
  const callsByModel: Record<string, number> = {};
  const handleSingleModel = async (_body: unknown, modelStr: string) => {
    callsByModel[modelStr] = (callsByModel[modelStr] ?? 0) + 1;
    return okResponse(`ok:${modelStr}`);
  };

  // "totallyunknownprovider" matches no registry entry, no name heuristic,
  // and no models.dev row -- resolveTokenLimit falls through to the generic,
  // non-specific catch-all for it.
  const result = await handleComboChat({
    body: {
      model: "test",
      messages: [{ role: "user", content: charsForTokens(5_000_000) }],
    },
    combo: makeCombo(["totallyunknownprovider/mystery-model"]),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(
    callsByModel["totallyunknownprovider/mystery-model"] ?? 0,
    1,
    "a target with an unknown/low-confidence limit must still be dispatched (fail-open)"
  );
  assert.equal(result.status, 200);
});
