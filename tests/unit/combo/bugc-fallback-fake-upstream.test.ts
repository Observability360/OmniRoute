/**
 * BUG_C reproducible fake-upstream tests for the o360-coding-style combo
 * fallback chain (see combo.ts's priority-strategy dispatch loop).
 *
 * These simulate the FAILURE OUTCOMES OmniRoute's own retry loop reacts to
 * (a status code, or a rejection) rather than literally waiting out a real
 * ~120s per-target timeout — the same idiom tests/unit/combo-499-abort.test.ts
 * already uses (a bare 499/502 Response stands in for "client disconnected" /
 * "transient upstream failure" without a real network call). A genuine
 * combo_target_timeout is represented here as a 504 Response with the same
 * shape targetTimeoutRunner.ts itself produces, since combo.ts's fallback
 * decision reacts to the STATUS CODE it gets back, not to how that status was
 * produced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-bugc-fallback-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "bugc-fallback-test-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

function makeCombo(models: string[]) {
  return {
    name: "test-bugc-combo",
    strategy: "priority",
    models: models.map((m) => ({ model: m })),
  };
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// T1: target1 = context overflow (400), target2 = timeout/abort (504,
// OmniRoute's own combo_target_timeout shape), target3 = 200.
// Expected: target3 is reached and its 200 response wins.
test("T1: 400 then combo_target_timeout(504) falls through to a healthy 3rd target", async () => {
  const modelsCalled: string[] = [];
  const handleSingleModel = async (_body: unknown, modelStr: string) => {
    modelsCalled.push(modelStr);
    if (modelsCalled.length === 1) {
      return jsonResponse(400, {
        error: { type: "invalid_request_error", code: "context_length_exceeded" },
      });
    }
    if (modelsCalled.length === 2) {
      return jsonResponse(504, {
        error: { type: "combo_target_timeout", code: "combo_target_timeout" },
      });
    }
    return jsonResponse(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
  };

  const result = await handleComboChat({
    body: { model: "test", messages: [{ role: "user", content: "hi" }] },
    combo: makeCombo(["cursor/auto-balance", "cx/gpt-5.6-sol-high", "zai/glm-5.3-flash-high"]),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(modelsCalled.length, 3, `expected all 3 targets attempted, got ${modelsCalled.length}: ${JSON.stringify(modelsCalled)}`);
  assert.equal(result.status, 200, "combo should resolve with the 3rd target's 200");
});

// T2: target1 = 400, target2 = 524 (the status the CALLER actually observed
// in the real incident — Cloudflare's own edge-timeout code), target3 = 503,
// target4 = 200. Expected: fallback reaches target4 and returns 200 — a 524
// reaching combo.ts's own retry loop must be treated as just another
// retryable/fallback-eligible status, never as fatal.
test("T2: 400, 524, 503 all fall through — fallback reaches the 4th target and returns 200", async () => {
  const modelsCalled: string[] = [];
  const handleSingleModel = async (_body: unknown, modelStr: string) => {
    modelsCalled.push(modelStr);
    const n = modelsCalled.length;
    if (n === 1) return jsonResponse(400, { error: { code: "context_length_exceeded" } });
    if (n === 2) return jsonResponse(524, { error: { code: "" } }); // caller-observed status
    if (n === 3) return jsonResponse(503, { error: { code: "service_unavailable" } });
    return jsonResponse(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
  };

  const result = await handleComboChat({
    body: { model: "test", messages: [{ role: "user", content: "hi" }] },
    combo: makeCombo([
      "cursor/auto-balance",
      "cx/gpt-5.6-sol-high",
      "zai/glm-5.3-flash-high",
      "cc/claude-sonnet-5",
    ]),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(modelsCalled.length, 4, `expected all 4 targets attempted, got ${modelsCalled.length}: ${JSON.stringify(modelsCalled)}`);
  assert.equal(result.status, 200, "combo should resolve with the 4th target's 200");
});

// T3: every target fails. Expected: a structured, non-empty diagnostic body —
// never an empty error envelope like the {"error":{"code":"","message":"",...}}
// the caller saw in the real incident — with a coherent (5xx) terminal status.
test("T3: all targets fail — terminal response is structured with real diagnostics, never an empty body", async () => {
  const modelsCalled: string[] = [];
  const handleSingleModel = async (_body: unknown, modelStr: string) => {
    modelsCalled.push(modelStr);
    return jsonResponse(502, { error: { code: "upstream_error", message: `${modelStr} failed` } });
  };

  const result = await handleComboChat({
    body: { model: "test", messages: [{ role: "user", content: "hi" }] },
    combo: makeCombo(["cursor/auto-balance", "cx/gpt-5.6-sol-high", "zai/glm-5.3-flash-high"]),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.ok(modelsCalled.length >= 1, "at least one target must have been attempted");
  assert.ok(result.status >= 500 && result.status < 600, `expected a coherent 5xx terminal status, got ${result.status}`);

  const rawBody = await result.text();
  assert.ok(rawBody.length > 0, "terminal error body must never be empty");
  const parsed = JSON.parse(rawBody);
  const message: string = JSON.stringify(parsed);
  assert.ok(
    message.length > 20 && message !== '{"error":{"code":"","message":"","param":"","type":""}}',
    `terminal error body must carry real diagnostics, got: ${message}`
  );
});
