/**
 * Explicit target dispatch — O360 explicit-target-routing V1.
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
  // second time on the same request, however many times "use <alias>" still
  // appears in the (unmodified, on purpose) message history.
  if (args.explicitTargetResolved) return null;

  const detected = detectExplicitTargetInBody(args.body);
  if (!detected) return null;
  const { alias } = detected;

  const traceInvocationId = args.invocationId;
  const record = (
    decision: Parameters<typeof recordComboDecision>[1]["decision"],
    target: string
  ) => {
    if (!traceInvocationId) return;
    recordComboDecision(traceInvocationId, { step: "explicit_target", target, decision });
  };

  const resolution = await resolveExplicitTarget({
    alias,
    combo: args.combo,
    allCombos: args.allCombos,
    isModelAvailable: args.isModelAvailable,
    maxComboDepth: args.maxComboDepth,
    hiddenModelsByProvider: args.hiddenModelsByProvider,
  });

  if (resolution.status === "unknown") {
    record("unknown_target", `alias=${alias}`);
    return errorResponse(
      400,
      `UNKNOWN_TARGET: "${alias}" does not match any configured alias, combo, target label, or model id`
    );
  }

  if (resolution.status === "ambiguous") {
    record(
      "ambiguous_target",
      `alias=${alias} tier=${resolution.tier} candidates=${resolution.candidates.join(",")}`
    );
    return errorResponse(
      409,
      `AMBIGUOUS_TARGET: "${alias}" matches more than one ${resolution.tier} candidate (${resolution.candidates.join(", ")}) — refusing to guess`
    );
  }

  if (resolution.kind === "model") {
    const { modelStr } = resolution;
    const unhealthy = await isPinnedModelDurablyUnhealthy(modelStr);
    if (unhealthy) {
      record("target_unavailable", `alias=${alias}->${modelStr}`);
      return errorResponse(
        503,
        `TARGET_UNAVAILABLE: "${alias}" resolved to ${modelStr}, which is currently durably unhealthy`
      );
    }
    const response = await args.handleSingleModelWithTimeout(args.body, modelStr, {
      modelPinned: false,
    } as SingleModelTarget);
    record("explicit_override", `alias=${alias}->${modelStr}`);
    return response;
  }

  // resolution.kind === "combo"
  const targetCombo = getComboFromData(resolution.comboName, args.allCombos);
  if (!targetCombo) {
    // Defensive only: resolution already validated the combo exists at
    // resolve time. A combo deleted in the window between resolution and
    // dispatch is a genuine (if vanishingly unlikely) race — fail closed
    // rather than silently falling through to the CALLER's own combo.
    record("target_unavailable", `alias=${alias}->combo/${resolution.comboName}`);
    return errorResponse(
      503,
      `TARGET_UNAVAILABLE: "${alias}" resolved to combo/${resolution.comboName}, which no longer exists`
    );
  }

  const nestedOptions: HandleComboChatOptions = {
    ...buildBaseOptions(args),
    combo: targetCombo,
    explicitTargetResolved: true,
  };
  const response = await args.runCombo(nestedOptions);
  record("explicit_override", `alias=${alias}->combo/${resolution.comboName}`);
  return response;
}
