/**
 * BUG_C: proves the abort-reason mislabeling is fixed.
 *
 * Before this fix, ANY abort of a combo target's outer (parent)
 * AbortController — a hedge sibling winning, the combo's own global safety
 * timeout, OR a plain client/caller disconnect — was unconditionally relabeled
 * "hedge-cancelled" by targetTimeoutRunner.ts's onParentHedgeAbort handler,
 * regardless of the TRUE reason. These tests exercise buildTargetTimeoutRunner
 * directly (the real production wrapper, not a reimplementation) and assert
 * the INNER signal handleSingleModel receives carries the SAME reason the
 * OUTER/parent controller was aborted with.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { buildTargetTimeoutRunner } = await import(
  "../../../open-sse/services/combo/targetTimeoutRunner.ts"
);
const {
  classifyAbortReason,
  COMBO_CLIENT_DISCONNECT_REASON,
  COMBO_HEDGE_LOSER_REASON,
  COMBO_LOOP_SAFETY_REASON,
  COMBO_HEDGE_CANCELLED_REASON,
  COMBO_UNKNOWN_ABORT_REASON,
} = await import("../../../open-sse/services/combo/comboAbortReasons.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

function neverResolves(): Promise<Response> {
  return new Promise(() => {});
}

test("a plain client-disconnect abort on the parent signal is classified client-disconnect, not hedge-cancelled", async () => {
  const parentController = new AbortController();
  let innerSignalSeenAtCallTime: AbortSignal | null = null;

  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async (_b, _m, target) => {
      innerSignalSeenAtCallTime = (target as { modelAbortSignal?: AbortSignal })
        ?.modelAbortSignal as AbortSignal;
      return neverResolves();
    },
    comboTargetTimeoutMs: 60_000,
    log,
  });

  const dispatch = runner({ messages: [] }, "cx/gpt-5.6-sol-high", {
    model: "cx/gpt-5.6-sol-high",
    provider: "cx",
    executionKey: "t1",
    modelAbortSignal: parentController.signal,
  } as never);

  await new Promise((r) => setTimeout(r, 10));
  parentController.abort(new Error(COMBO_CLIENT_DISCONNECT_REASON));
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(innerSignalSeenAtCallTime, "handleSingleModel must have been invoked");
  const classification = classifyAbortReason(innerSignalSeenAtCallTime);
  assert.equal(
    classification,
    COMBO_CLIENT_DISCONNECT_REASON,
    `expected the real client-disconnect reason to propagate, got "${classification}"`
  );
  assert.notEqual(
    classification,
    COMBO_HEDGE_CANCELLED_REASON,
    "a plain client disconnect must never be mislabeled hedge-cancelled"
  );

  void dispatch; // response never resolves in this synthetic scenario; only the signal matters
});

test("a genuine hedge-loser abort on the parent signal is classified hedge-loser-cancelled", async () => {
  const parentController = new AbortController();
  let innerSignalSeenAtCallTime: AbortSignal | null = null;

  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async (_b, _m, target) => {
      innerSignalSeenAtCallTime = (target as { modelAbortSignal?: AbortSignal })
        ?.modelAbortSignal as AbortSignal;
      return neverResolves();
    },
    comboTargetTimeoutMs: 60_000,
    log,
  });

  runner({ messages: [] }, "cx/gpt-5.6-sol-high", {
    model: "cx/gpt-5.6-sol-high",
    provider: "cx",
    executionKey: "t2",
    modelAbortSignal: parentController.signal,
  } as never);

  await new Promise((r) => setTimeout(r, 10));
  parentController.abort(new Error(COMBO_HEDGE_LOSER_REASON));
  await new Promise((r) => setTimeout(r, 10));

  const classification = classifyAbortReason(innerSignalSeenAtCallTime);
  assert.equal(classification, COMBO_HEDGE_LOSER_REASON);
});

test("a combo-level loop-safety abort on the parent signal is classified combo-timeout", async () => {
  const parentController = new AbortController();
  let innerSignalSeenAtCallTime: AbortSignal | null = null;

  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async (_b, _m, target) => {
      innerSignalSeenAtCallTime = (target as { modelAbortSignal?: AbortSignal })
        ?.modelAbortSignal as AbortSignal;
      return neverResolves();
    },
    comboTargetTimeoutMs: 60_000,
    log,
  });

  runner({ messages: [] }, "cx/gpt-5.6-sol-high", {
    model: "cx/gpt-5.6-sol-high",
    provider: "cx",
    executionKey: "t3",
    modelAbortSignal: parentController.signal,
  } as never);

  await new Promise((r) => setTimeout(r, 10));
  parentController.abort(new Error(COMBO_LOOP_SAFETY_REASON));
  await new Promise((r) => setTimeout(r, 10));

  const classification = classifyAbortReason(innerSignalSeenAtCallTime);
  assert.equal(classification, COMBO_LOOP_SAFETY_REASON);
});

test("the combo's OWN per-target timeout is still classified as its own (unaffected) reason", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () => neverResolves(),
    comboTargetTimeoutMs: 20,
    log,
  });

  const response = await runner({ messages: [] }, "cx/gpt-5.6-sol-high", {
    model: "cx/gpt-5.6-sol-high",
    provider: "cx",
    executionKey: "t4",
  } as never);

  assert.equal(response.status, 504);
  const body = (await response.json()) as { error: { type: string; code: string } };
  assert.equal(body.error.type, "combo_target_timeout");
});

test("classifyAbortReason falls back to unknown-abort for an untagged (bare) AbortError", () => {
  const ac = new AbortController();
  ac.abort(); // bare abort, no custom reason — the pre-fix behavior at every call site
  const classification = classifyAbortReason(ac.signal);
  assert.equal(classification, COMBO_UNKNOWN_ABORT_REASON);
  assert.notEqual(
    classification,
    COMBO_HEDGE_CANCELLED_REASON,
    "an untagged abort must be 'unknown', never silently assumed to be a hedge cancellation"
  );
});

test("classifyAbortReason returns not-aborted for a signal that never fired", () => {
  const ac = new AbortController();
  assert.equal(classifyAbortReason(ac.signal), "not-aborted");
});
