/**
 * Shared abort reasons for combo target dispatch.
 *
 * `buildTargetTimeoutRunner` aborts a stalled target with `new Error(...)` as the
 * abort reason. Several DIFFERENT things can abort a target's outer (parent)
 * AbortController — a hedge sibling winning, the combo's own global safety
 * timeout, or the calling client (Coder, or an intermediary such as
 * Cloudflare's edge) disconnecting — and each must be tagged with its OWN
 * reason at the `.abort()` call site. Consumers downstream (session-affinity
 * eviction in src/sse/handlers/chat.ts, and combo observability) must be able
 * to tell these apart: only the per-model TIMEOUT means "this account
 * stalled"; a hedge-loser cancellation means "a sibling target won" and says
 * nothing about the account's health; a client-disconnect means the caller is
 * gone and says nothing about EITHER the account or the sibling.
 *
 * BUG_C (2026-09): before this file grew the extra reasons below,
 * `targetTimeoutRunner.ts`'s parent-abort handler unconditionally re-labeled
 * ANY parent abort as COMBO_HEDGE_CANCELLED_REASON, because the abort call
 * sites in combo.ts called bare `.abort()` with no reason at all. A genuine
 * client disconnect (e.g. Cloudflare's edge giving up on the upstream
 * connection and returning 524 to the caller, while OmniRoute's own request
 * signal is torn down a few seconds later) was therefore observability-logged
 * as "hedge-cancelled" even on combos with hedging OFF. Fixed by giving every
 * abort call site its own explicit reason and having targetTimeoutRunner
 * propagate it instead of overwriting it — see classifyAbortReason below.
 *
 * Kept as a dependency-free leaf so src/** can import it without pulling in the
 * combo dispatcher.
 */

/** Abort reason used when a combo target exceeds `comboTargetTimeoutMs` (OmniRoute's own per-target timer). */
export const COMBO_PER_MODEL_TIMEOUT_REASON = "combo-per-model-timeout";

/** Generic/legacy abort reason retained for backward compatibility with any caller matching this exact string. Prefer COMBO_HEDGE_LOSER_REASON for new call sites — a genuine hedge-sibling-won cancellation. */
export const COMBO_HEDGE_CANCELLED_REASON = "hedge-cancelled";

/** Abort reason used when a hedge race is lost because a SIBLING target already succeeded. */
export const COMBO_HEDGE_LOSER_REASON = "hedge-loser-cancelled";

/** Abort reason used when the combo's own global safety/loop timeout (comboTimeoutMs / COMBO_LOOP_SAFETY_TIMEOUT_MS) fires. */
export const COMBO_LOOP_SAFETY_REASON = "combo-timeout";

/** Abort reason used when the calling client's request signal aborts — the caller disconnected, or an intermediary (e.g. Cloudflare's edge) gave up and closed the connection. Also covers a nested combo's outer/parent request being cancelled. */
export const COMBO_CLIENT_DISCONNECT_REASON = "client-disconnect";

/** Abort reason used when a fallback decision deliberately aborts an in-flight attempt to move to the next target (reserved for future fallback-triggered aborts distinct from a hedge-loser or timeout). */
export const COMBO_FALLBACK_ABORT_REASON = "fallback-abort";

/** Display classification returned by classifyAbortReason when a signal is aborted but carries none of the reasons above (e.g. a bare AbortError from code that has not been migrated to pass an explicit reason yet). */
export const COMBO_UNKNOWN_ABORT_REASON = "unknown-abort";

const KNOWN_ABORT_REASONS: ReadonlySet<string> = new Set([
  COMBO_PER_MODEL_TIMEOUT_REASON,
  COMBO_HEDGE_CANCELLED_REASON,
  COMBO_HEDGE_LOSER_REASON,
  COMBO_LOOP_SAFETY_REASON,
  COMBO_CLIENT_DISCONNECT_REASON,
  COMBO_FALLBACK_ABORT_REASON,
]);

function abortReasonMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object" && typeof (reason as Error).message === "string") {
    return (reason as Error).message;
  }
  return "";
}

/**
 * True only when `signal` was aborted by the combo per-model timeout. A client
 * disconnect, a hedge cancellation, or a non-aborted signal all return false.
 */
export function isComboPerModelTimeoutAbort(signal: AbortSignal | null | undefined): boolean {
  if (!signal?.aborted) return false;
  return abortReasonMessage(signal) === COMBO_PER_MODEL_TIMEOUT_REASON;
}

/**
 * Classifies WHY a combo target's abort signal fired, for logging/observability
 * only (never for control flow — callers that need to branch on the per-model
 * timeout specifically should keep using isComboPerModelTimeoutAbort). Returns
 * one of the COMBO_*_REASON string constants above, or COMBO_UNKNOWN_ABORT_REASON
 * when the signal is aborted but was not tagged with a recognized reason, or
 * "not-aborted" when the signal has not fired at all.
 */
export function classifyAbortReason(signal: AbortSignal | null | undefined): string {
  if (!signal?.aborted) return "not-aborted";
  const msg = abortReasonMessage(signal);
  return KNOWN_ABORT_REASONS.has(msg) ? msg : COMBO_UNKNOWN_ABORT_REASON;
}
