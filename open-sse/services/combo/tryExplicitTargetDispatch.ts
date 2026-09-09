/**
 * Explicit target dispatch — O360 explicit-target-routing V1 (hybrid
 * contract).
 *
 * Two ways a human can name a target, checked in this order — the first to
 * match wins completely, the second is never even consulted:
 *
 *   1. "/route <target>" (routeSlashCommand.ts) — the DETERMINISTIC control
 *      API. An unresolved "/route" target ALWAYS fails closed
 *      (UNKNOWN_TARGET): the syntax itself is unambiguous, so there is no
 *      "was this really meant as a command?" question left to hedge on.
 *      Also the only path that mutates the forwarded task content — see
 *      routeSlashCommand.ts's strippedTaskContent.
 *   2. natural language ("use <alias>", explicitTargetDetector.ts) — the
 *      CONVENIENCE path. Deliberately conservative: an unresolved candidate
 *      here falls through to ordinary chat instead of failing closed,
 *      because ordinary prose constantly takes the exact same shape
 *      ("use combo fallback", "manda a mensagem") with zero routing intent,
 *      and real targets are routinely lowercase (combo names, model ids) so
 *      capitalization can't be used to tell those apart either. Full
 *      message-history passthrough, unmodified — natural language never
 *      rewrites the request body.
 *
 * The prelude branch handleComboChatInner calls immediately after
 * phaseComboSetup() and BEFORE it acts on a context-cache/session pin. A
 * resolved explicit target always wins over that pin: the pin was already
 * computed (and may have rewritten ctx.body.model) by the time this runs, but
 * that value is simply never read on this path — returning a Response here
 * means the pinned-model branch, and everything after it, never executes.
 *
 * Two destination shapes, two dispatch mechanisms — both already provided by
 * the caller, neither reimplemented here:
 *   - a bare model/provider id  → handleSingleModelWithTimeout (same primitive
 *     tryPinnedModelDispatch uses), with the SAME durable-health gate
 *     (isPinnedModelDurablyUnhealthy) — but fail-closed on failure, never a
 *     silent fall-through to strategy.
 *   - a combo name             → the same RunCombo callback (handleComboChat)
 *     already threaded through the dispatch prelude for nested combo-refs,
 *     called with the SAME full, unmodified body (full message history
 *     passthrough) and the internal explicitTargetResolved recursion guard set.
 *
 * Every branch records exactly one decision on the request's existing combo
 * trace (recordComboDecision) — no new audit subsystem.
 */
import { errorResponse } from "../../utils/error.ts";
import { detectExplicitTargetInBody } from "./explicitTargetDetector.ts";
import { detectRouteSlashCommandInBody } from "./routeSlashCommand.ts";
import { resolveExplicitTarget } from "./explicitTargetResolver.ts";
import {
  isPinnedModelDurablyUnhealthy,
  buildBaseOptions,
  type PreludeBaseOptionArgs,
} from "./dispatchPrelude.ts";
import { getComboFromData } from "./comboStructure.ts";
import { recordComboDecision } from "./decisionTrace.ts";
import type {
  ComboCollectionLike,
  HandleComboChatOptions,
  HandleSingleModel,
  IsModelAvailable,
  SingleModelTarget,
} from "./types.ts";

type RunCombo = (options: HandleComboChatOptions) => Promise<Response>;

/** Where a candidate target came from — recorded on the trace and also what
 *  decides fail-closed-on-unknown vs. fall-through (see module doc comment). */
type ExplicitTargetSource = "slash_command" | "natural_language";

/**
 * Replace the LAST role="user" message's content with a new plain string,
 * leaving every earlier message (and the message array's own identity for
 * anything but that one entry) untouched. Used only for a "/route" match —
 * natural language never rewrites the body (see module doc comment).
 */
function replaceLastUserMessageContent(
  body: Record<string, unknown>,
  newContent: string
): Record<string, unknown> {
  const raw = body?.messages;
  const messages = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const idx = messages.map((m) => m?.role).lastIndexOf("user");
  if (idx === -1) return body;
  const newMessages = messages.slice();
  newMessages[idx] = { ...messages[idx], content: newContent };
  return { ...body, messages: newMessages };
}

export async function tryExplicitTargetDispatch(
  args: PreludeBaseOptionArgs & {
    isModelAvailable?: IsModelAvailable;
    handleSingleModelWithTimeout: HandleSingleModel;
    allCombos?: ComboCollectionLike;
    maxComboDepth?: unknown;
    runCombo: RunCombo;
    explicitTargetResolved?: boolean;
  }
): Promise<Response | null> {
  // Recursion guard: this invocation is itself the result of an explicit
  // override (a combo-typed target dispatched via runCombo). Never detect a
  // second time on the same request, however many times "/route"/"use
  // <alias>" still appears in the (unmodified, on purpose) message history.
  if (args.explicitTargetResolved) return null;

  const traceInvocationId = args.invocationId;
  const record = (
    decision: Parameters<typeof recordComboDecision>[1]["decision"],
    target: string
  ) => {
    if (!traceInvocationId) return;
    recordComboDecision(traceInvocationId, { step: "explicit_target", target, decision });
  };

  const slashMatch = detectRouteSlashCommandInBody(args.body);
  if (slashMatch) {
    if (!slashMatch.strippedTaskContent) {
      record("missing_task", `source=slash_command alias=${slashMatch.target}`);
      return errorResponse(
        400,
        `MISSING_TASK: "/route ${slashMatch.target}" has no task content — add task text on the same line after the target, or on the following line`
      );
    }
    const forwardBody = replaceLastUserMessageContent(args.body, slashMatch.strippedTaskContent);
    return dispatchResolvedTarget({
      args,
      forwardBody,
      alias: slashMatch.target,
      source: "slash_command",
      // Deterministic syntax: an unresolved "/route" target ALWAYS fails
      // closed. There is no lower-confidence fallback tier for this path.
      failClosedOnUnknown: true,
      // The user explicitly typed this exact string as a target — tier 4
      // (literal model id, resolveExplicitTarget's isModelAvailable check)
      // is exactly what "/route cx/gpt-5.6-sol-high" needs.
      allowLiteralModelIdLookup: true,
      record,
    });
  }

  const nlMatch = detectExplicitTargetInBody(args.body);
  if (!nlMatch) return null;
  return dispatchResolvedTarget({
    args,
    forwardBody: args.body,
    alias: nlMatch.alias,
    source: "natural_language",
    // Convenience syntax: an unresolved natural-language candidate falls
    // through to ordinary chat instead of failing closed — see module doc
    // comment for why capitalization/strength heuristics were dropped.
    failClosedOnUnknown: false,
    // Tier 4 (literal model id) must NEVER be reached for a natural-language
    // candidate. The production isModelAvailable check (checkModelAvailable,
    // src/sse/handlers/chat.ts) is written for a string the CALLER already
    // believes might be a real model id — fed an arbitrary single word
    // extracted from ordinary prose ("Use combo fallback" → candidate
    // "combo"), it does not reliably return false for nonsense, and a false
    // "yes" here would dispatch straight to a bogus literal model id instead
    // of falling through. Restricting NL to tiers 1-3 (synonym/combo-name/
    // label — all local, deterministic lookups) is what makes the
    // fall-through guarantee actually safe.
    allowLiteralModelIdLookup: false,
    record,
  });
}

/**
 * Gate tier 4 (literal model id, resolveExplicitTarget's isModelAvailable
 * check) on the source's own confidence — see the "natural_language" call
 * site's doc comment above for why NL must never reach it. Split out purely
 * to keep dispatchResolvedTarget's own branching flat; no behavior change.
 */
function selectIsModelAvailable(
  isModelAvailable: IsModelAvailable | undefined,
  allowLiteralModelIdLookup: boolean
): IsModelAvailable | undefined {
  return allowLiteralModelIdLookup ? isModelAvailable : undefined;
}

async function dispatchResolvedTarget(opts: {
  args: PreludeBaseOptionArgs & {
    isModelAvailable?: IsModelAvailable;
    handleSingleModelWithTimeout: HandleSingleModel;
    allCombos?: ComboCollectionLike;
    maxComboDepth?: unknown;
    runCombo: RunCombo;
  };
  forwardBody: Record<string, unknown>;
  alias: string;
  source: ExplicitTargetSource;
  failClosedOnUnknown: boolean;
  allowLiteralModelIdLookup: boolean;
  record: (decision: Parameters<typeof recordComboDecision>[1]["decision"], target: string) => void;
}): Promise<Response | null> {
  const {
    args,
    forwardBody,
    alias,
    source,
    failClosedOnUnknown,
    allowLiteralModelIdLookup,
    record,
  } = opts;

  const resolution = await resolveExplicitTarget({
    alias,
    combo: args.combo,
    allCombos: args.allCombos,
    isModelAvailable: selectIsModelAvailable(args.isModelAvailable, allowLiteralModelIdLookup),
    maxComboDepth: args.maxComboDepth,
    hiddenModelsByProvider: args.hiddenModelsByProvider,
  });

  if (resolution.status === "unknown") {
    if (!failClosedOnUnknown) {
      record("weak_unresolved_fallthrough", `source=${source} alias=${alias}`);
      return null;
    }
    record("unknown_target", `source=${source} alias=${alias}`);
    return errorResponse(
      400,
      `UNKNOWN_TARGET: "${alias}" does not match any configured alias, combo, target label, or model id`
    );
  }

  if (resolution.status === "ambiguous") {
    record(
      "ambiguous_target",
      `source=${source} alias=${alias} tier=${resolution.tier} candidates=${resolution.candidates.join(",")}`
    );
    return errorResponse(
      409,
      `AMBIGUOUS_TARGET: "${alias}" matches more than one ${resolution.tier} candidate (${resolution.candidates.join(", ")}) — refusing to guess`
    );
  }

  if (resolution.kind === "model") {
    return dispatchToModel(args, forwardBody, alias, source, resolution.modelStr, record);
  }
  return dispatchToCombo(args, forwardBody, alias, source, resolution.comboName, record);
}

type DispatchRecord = (
  decision: Parameters<typeof recordComboDecision>[1]["decision"],
  target: string
) => void;

async function dispatchToModel(
  args: { handleSingleModelWithTimeout: HandleSingleModel },
  forwardBody: Record<string, unknown>,
  alias: string,
  source: ExplicitTargetSource,
  modelStr: string,
  record: DispatchRecord
): Promise<Response> {
  const unhealthy = await isPinnedModelDurablyUnhealthy(modelStr);
  if (unhealthy) {
    record("target_unavailable", `source=${source} alias=${alias}->${modelStr}`);
    return errorResponse(
      503,
      `TARGET_UNAVAILABLE: "${alias}" resolved to ${modelStr}, which is currently durably unhealthy`
    );
  }
  const response = await args.handleSingleModelWithTimeout(forwardBody, modelStr, {
    modelPinned: false,
  } as SingleModelTarget);
  record("explicit_override", `source=${source} alias=${alias}->${modelStr}`);
  return response;
}

async function dispatchToCombo(
  args: PreludeBaseOptionArgs & { allCombos?: ComboCollectionLike; runCombo: RunCombo },
  forwardBody: Record<string, unknown>,
  alias: string,
  source: ExplicitTargetSource,
  comboName: string,
  record: DispatchRecord
): Promise<Response> {
  const targetCombo = getComboFromData(comboName, args.allCombos);
  if (!targetCombo) {
    // Defensive only: resolution already validated the combo exists at
    // resolve time. A combo deleted in the window between resolution and
    // dispatch is a genuine (if vanishingly unlikely) race — fail closed
    // rather than silently falling through to the CALLER's own combo.
    record("target_unavailable", `source=${source} alias=${alias}->combo/${comboName}`);
    return errorResponse(
      503,
      `TARGET_UNAVAILABLE: "${alias}" resolved to combo/${comboName}, which no longer exists`
    );
  }

  const nestedOptions: HandleComboChatOptions = {
    ...buildBaseOptions({ ...args, body: forwardBody }),
    combo: targetCombo,
    explicitTargetResolved: true,
  };
  const response = await args.runCombo(nestedOptions);
  record("explicit_override", `source=${source} alias=${alias}->combo/${comboName}`);
  return response;
}
