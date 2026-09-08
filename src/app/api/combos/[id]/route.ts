import { NextResponse } from "next/server";
import { getComboById, updateCombo, deleteCombo, getComboByName, getCombos } from "@/lib/db/combos";
import { isCloudEnabled } from "@/lib/db/settings";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";
import { validateCompositeTiersConfig } from "@/lib/combos/compositeTiers";
import { normalizeComboModels } from "@/lib/combos/steps";
import { validateComboDAG, clampComboDepth } from "@omniroute/open-sse/services/combo.ts";
import { updateComboSchema } from "@/shared/validation/schemas";
import { requiresQuotaOnlyComboRefExecute } from "@/shared/validation/schemas/combo";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { QUOTA_MODEL_PREFIX } from "@/lib/quota/quotaModelNaming";
import { comboErrorResponse } from "@/lib/api/comboErrorResponse";
import { ComboInvariantError } from "@/lib/combos/invariants";
import { buildComboNameCollisionWarning } from "@/lib/combos/modelNameCollision";
import {
  beginStrictAuditEvent,
  getAuditRequestContext,
  logAuditEvent,
} from "@/lib/compliance/index";
import { getManagementAuditActor } from "@/lib/compliance/managementAuditActor";
import type { ComboRecord } from "@/domain/persistence/comboRepositories";

// Minimal shape for the fields we read off a combo row in this route.
// `getComboById` returns a structurally `JsonRecord`-typed object, so we
// narrow at the call sites rather than change the DB helper's return type.
type ComboRowShape = {
  name: string;
  id?: string;
  config?: unknown;
  models?: unknown;
  strategy?: string;
  isActive?: boolean;
  allowedProviders?: string[];
  system_message?: string;
  tool_filter_regex?: string;
  context_cache_protection?: boolean;
  context_length?: number | null;
};

/**
 * Keys that were present in older combo configs (≤ v3.8.31) but have since been
 * removed from comboRuntimeConfigSchema. The dashboard modal sanitises the three
 * UI-level keys (timeoutMs, healthCheckEnabled, healthCheckTimeoutMs) before PUT,
 * but v3.8.31-era stored configs also carry these 12 keys which were spread back
 * into the body on edit+save. We strip them server-side so removed keys don't
 * accumulate in `combos.data` and so the next read produces a clean config.
 *
 * Idempotent — running twice is a no-op.
 */
const LEGACY_REMOVED_COMBO_CONFIG_KEYS = Object.freeze([
  "queueDepth",
  "fallbackDelayMs",
  "handoffProviders",
  "maxComboDepth",
  "manifestRouting",
  "complexityAwareRouting",
  "pipeline_enabled",
  "pipelineConcurrency",
  "shadowRouting",
  "evalRouting",
  "resetAwareEnabled",
  "resetAwareWindow",
]);

function stripLegacyComboConfigKeys(rawConfig) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    return rawConfig;
  }
  let mutated = false;
  const next = {};
  for (const [key, value] of Object.entries(rawConfig)) {
    if (LEGACY_REMOVED_COMBO_CONFIG_KEYS.includes(key)) {
      mutated = true;
      continue;
    }
    next[key] = value;
  }
  return mutated ? next : rawConfig;
}

// GET /api/combos/[id] - Get combo by ID
export async function GET(request, { params }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const combo = await getComboById(id);

    if (!combo) {
      return comboErrorResponse("COMBO_007", 404, { id }, request);
    }

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return comboErrorResponse("INTERNAL_001", 500, undefined, request);
  }
}

// Sanitize the raw `dagError.message` — it can leak internal combo names.
// Log full error server-side for debugging; the caller returns a sanitized
// generic message to the client with just this short reason tag.
function classifyComboDagError(
  dagError: unknown
): "cycle-detected" | "max-depth-exceeded" | "invalid-graph" {
  if (dagError instanceof Error && /cycle/i.test(dagError.message)) return "cycle-detected";
  if (dagError instanceof Error && /depth/i.test(dagError.message)) return "max-depth-exceeded";
  return "invalid-graph";
}

// Validate nested combo DAG (no circular references, max depth) for a
// PUT/PATCH body that touches `models`. Returns an error Response on failure,
// or null when the DAG is valid (including the "nothing to validate" cases:
// no `models` in the body, or an unnamed combo).
function validateComboUpdateDag(
  request,
  id: string,
  comboName: unknown,
  body: { models?: unknown },
  allCombos: ComboRecord[],
  nextComboState: { config?: { maxComboDepth?: unknown } }
) {
  if (!body.models || !comboName) return null;
  // Update the combo in the list temporarily for validation
  const updatedCombos = allCombos.map((c) => (c.id === id ? { ...c, ...body } : c));
  const configuredDepth = clampComboDepth(nextComboState.config?.maxComboDepth);
  try {
    validateComboDAG(String(comboName), updatedCombos, new Set(), 0, configuredDepth);
    return null;
  } catch (dagError) {
    console.warn("Combo DAG validation failed:", dagError);
    const reason = classifyComboDagError(dagError);
    return comboErrorResponse("COMBO_005", 400, { comboName, reason }, request);
  }
}

// Pure computation of the normalized update body + the combo state it would
// produce, given the already-schema-validated update data. No DB reads, no
// early-return responses — those stay in resolveComboUpdate.
function buildNormalizedComboBody(
  currentCombo: ComboRowShape,
  comboName: unknown,
  updateData: Record<string, unknown>,
  allCombos: ComboRecord[]
) {
  const normalizedUpdate = { ...updateData };
  if (normalizedUpdate.compressionOverride !== undefined) {
    const legacyCompressionOverride = normalizedUpdate.compressionOverride;
    const nextConfig: Record<string, unknown> =
      currentCombo.config &&
      typeof currentCombo.config === "object" &&
      !Array.isArray(currentCombo.config)
        ? { ...(currentCombo.config as Record<string, unknown>) }
        : {};
    if (legacyCompressionOverride) {
      nextConfig.compressionMode = legacyCompressionOverride;
    } else {
      delete nextConfig.compressionMode;
    }
    normalizedUpdate.config = nextConfig;
    delete normalizedUpdate.compressionOverride;
  }
  if (normalizedUpdate.config && typeof normalizedUpdate.config === "object") {
    normalizedUpdate.config = stripLegacyComboConfigKeys(normalizedUpdate.config);
  }

  const body = normalizedUpdate.models
    ? {
        ...normalizedUpdate,
        models: normalizeComboModels(normalizedUpdate.models, {
          comboName: String(comboName),
          // `allCombos` from `getCombos()` is typed as the DB-shaped record
          // (JsonRecord & { version: 2; models: ComboStep[] }) which is
          // structurally compatible with the local ComboCollectionLike in
          // `normalizeComboModels` but TS does not infer the relationship.
          allCombos: allCombos as never,
        }),
      }
    : normalizedUpdate;
  const nextComboState = {
    ...currentCombo,
    ...body,
    name: comboName,
  };
  return { body, nextComboState };
}

// The two structural checks on the would-be next combo state: quota-only
// combo refs must use nestedComboMode execute, and composite-tiers config
// must itself validate. Returns an error Response, or null when both pass.
function validateComboUpdateState(request, nextComboState: unknown) {
  if (requiresQuotaOnlyComboRefExecute(nextComboState as never)) {
    return comboErrorResponse(
      "COMBO_002",
      400,
      {
        firstField: "config.nestedComboMode",
        firstMessage: "Quota-only combo references require nestedComboMode execute",
      },
      request
    );
  }
  const compositeValidation = validateCompositeTiersConfig(nextComboState);
  if (compositeValidation.success === false) {
    const failure = compositeValidation as {
      success: false;
      error: { message: string; details: unknown[] };
    };
    return comboErrorResponse(
      "COMBO_003",
      400,
      { reason: failure.error.message, details: failure.error.details },
      request
    );
  }
  return null;
}

// Name collision check (excluding the combo being updated itself). Returns
// an error Response, or null when the name is free.
async function checkComboNameCollision(request, id: string, name: string | undefined) {
  if (!name) return null;
  const existing = await getComboByName(name);
  if (existing && existing.id !== id) {
    return comboErrorResponse("COMBO_004", 400, { name, conflictingId: existing.id }, request);
  }
  return null;
}

type ComboUpdateResolution =
  | { ok: false; response: Response }
  | {
      ok: true;
      currentCombo: ComboRowShape;
      body: Record<string, unknown>;
      comboName: unknown;
    };

// Everything from body-schema validation through DAG validation for
// PUT/PATCH /api/combos/[id] — same order as before this was extracted, so
// which error wins when multiple conditions are true is unchanged.
async function resolveComboUpdate(
  request,
  id: string,
  rawBody: unknown
): Promise<ComboUpdateResolution> {
  const validation = validateBody(updateComboSchema, rawBody);
  if (isValidationFailure(validation)) {
    // Surface the first field-level issue so clients can highlight the
    // offending field without parsing the full issues array (#5083 Bug 3).
    const firstDetail = validation.error.details?.[0] ?? null;
    return {
      ok: false,
      response: comboErrorResponse(
        "COMBO_002",
        400,
        {
          issues: validation.error,
          firstField: firstDetail?.field ?? null,
          firstMessage: firstDetail?.message ?? null,
        },
        request
      ),
    };
  }
  const currentCombo = (await getComboById(id)) as ComboRowShape | null;
  if (!currentCombo) {
    return { ok: false, response: comboErrorResponse("COMBO_007", 404, { id }, request) };
  }
  if (currentCombo.name.startsWith(QUOTA_MODEL_PREFIX)) {
    return {
      ok: false,
      response: comboErrorResponse(
        "COMBO_006",
        409,
        { name: currentCombo.name, source: "quota-share" },
        request
      ),
    };
  }
  const allCombos = await getCombos();

  const comboName = validation.data.name || currentCombo.name;
  const { body, nextComboState } = buildNormalizedComboBody(
    currentCombo,
    comboName,
    validation.data,
    allCombos
  );
  const stateError = validateComboUpdateState(request, nextComboState);
  if (stateError) return { ok: false, response: stateError };

  const nameCollisionError = await checkComboNameCollision(
    request,
    id,
    body.name as string | undefined
  );
  if (nameCollisionError) return { ok: false, response: nameCollisionError };

  const dagError = validateComboUpdateDag(request, id, comboName, body, allCombos, nextComboState);
  if (dagError) return { ok: false, response: dagError };

  return { ok: true, currentCombo, body, comboName };
}

// PUT /api/combos/[id] - Update combo
export async function PUT(request, { params }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return comboErrorResponse(
      "COMBO_001",
      400,
      { field: "body", reason: "Invalid JSON body" },
      request
    );
  }

  try {
    const { id } = await params;
    const resolution = await resolveComboUpdate(request, id, rawBody);
    if (resolution.ok === false) return resolution.response;
    const { currentCombo, body, comboName } = resolution;

    // Config-mutation audit trail (#combo-config-audit). before=currentCombo
    // (read at the top of this handler, pre-mutation), after=the real
    // updateCombo() result. Real caller identity — see
    // managementAuditActor.ts — sourced from the same auth signals
    // requireManagementAuth() already used to authenticate this request.
    //
    // Strict pre-mutation gate (#combo-config-audit follow-up — "no
    // unattributed combo mutation"): the audit ATTEMPT must be written
    // BEFORE the mutation and must abort the request (previous combo state
    // untouched) if that write fails.
    //
    // `before`/`requested` (#combo-config-audit follow-up 2): the ATTEMPT
    // row carries the pre-mutation state and the exact normalized body about
    // to be passed to updateCombo(), so evidence of the intended change
    // survives even if the finalize SUCCESS write never lands. Same
    // serialization + sanitizeAuditValue redaction as every other audit
    // field — no new sanitizer.
    const auditContext = getAuditRequestContext(request);
    const { actor, authKind, authLabel } = await getManagementAuditActor(request);

    let strictRequestId: string;
    try {
      ({ requestId: strictRequestId } = beginStrictAuditEvent({
        action: "combo.update",
        actor,
        target: id,
        resourceType: "combo",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { comboName, authKind, authLabel, before: currentCombo, requested: body },
      }));
    } catch (auditError) {
      console.error(
        "[combo-config-audit] strict audit write failed — refusing to update combo:",
        auditError
      );
      return comboErrorResponse("INTERNAL_001", 503, { reason: "audit_unavailable" }, request);
    }

    let combo;
    try {
      combo = await updateCombo(id, body);
    } catch (mutationError) {
      logAuditEvent({
        action: "combo.update",
        actor,
        target: id,
        resourceType: "combo",
        status: "failure",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: strictRequestId,
        metadata: {
          comboName,
          authKind,
          authLabel,
          error: mutationError instanceof Error ? mutationError.message : String(mutationError),
        },
      });
      throw mutationError;
    }

    logAuditEvent({
      action: "combo.update",
      actor,
      target: id,
      resourceType: "combo",
      status: "success",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: strictRequestId,
      metadata: { comboName, before: currentCombo, after: combo, authKind, authLabel },
    });

    // Auto sync to Cloud if enabled
    await syncToCloudIfEnabled();

    // #8530: a combo renamed to a real model id is a supported pattern
    // (#6940 — bare-model-id provider fallback), so it is never rejected.
    // Surface it as a non-blocking warning instead of silently shadowing it.
    const warning = comboName ? buildComboNameCollisionWarning(String(comboName)) : null;
    return NextResponse.json(warning ? { ...combo, warning } : combo);
  } catch (error) {
    if (error instanceof ComboInvariantError) {
      return comboErrorResponse("COMBO_008", 400, { reason: error.message }, request);
    }
    console.log("Error updating combo:", error);
    return comboErrorResponse("INTERNAL_001", 500, undefined, request);
  }
}

// PATCH /api/combos/[id] - partial update. PUT merges the body onto the stored
// combo, so both verbs share one handler (same shape as /api/providers/[id]).
export async function PATCH(request, ctx) {
  return PUT(request, ctx);
}

// DELETE /api/combos/[id] - Delete combo
export async function DELETE(request, { params }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const existingCombo = (await getComboById(id)) as ComboRowShape | null;
    if (!existingCombo) {
      return comboErrorResponse("COMBO_007", 404, { id }, request);
    }
    if (existingCombo.name.startsWith(QUOTA_MODEL_PREFIX)) {
      return comboErrorResponse(
        "COMBO_006",
        409,
        { name: existingCombo.name, source: "quota-share" },
        request
      );
    }
    // Config-mutation audit trail (#combo-config-audit). after=null (deleted).
    // Real caller identity — see managementAuditActor.ts.
    //
    // Strict pre-mutation gate (#combo-config-audit follow-up — "no
    // unattributed combo mutation"): the audit ATTEMPT must be written
    // BEFORE the mutation and must abort the request (combo not deleted) if
    // that write fails.
    //
    // `before: existingCombo` (#combo-config-audit follow-up 2): the ATTEMPT
    // row carries the full pre-deletion state, so evidence of what was about
    // to be deleted survives even if the finalize SUCCESS write never
    // lands. Same serialization + sanitizeAuditValue redaction as every
    // other audit field — no new sanitizer.
    const auditContext = getAuditRequestContext(request);
    const { actor, authKind, authLabel } = await getManagementAuditActor(request);

    let strictRequestId: string;
    try {
      ({ requestId: strictRequestId } = beginStrictAuditEvent({
        action: "combo.delete",
        actor,
        target: id,
        resourceType: "combo",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { comboName: existingCombo.name, authKind, authLabel, before: existingCombo },
      }));
    } catch (auditError) {
      console.error(
        "[combo-config-audit] strict audit write failed — refusing to delete combo:",
        auditError
      );
      return comboErrorResponse("INTERNAL_001", 503, { reason: "audit_unavailable" }, request);
    }

    let success: boolean;
    try {
      success = await deleteCombo(id);
    } catch (mutationError) {
      logAuditEvent({
        action: "combo.delete",
        actor,
        target: id,
        resourceType: "combo",
        status: "failure",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: strictRequestId,
        metadata: {
          comboName: existingCombo.name,
          authKind,
          authLabel,
          error: mutationError instanceof Error ? mutationError.message : String(mutationError),
        },
      });
      throw mutationError;
    }

    if (!success) {
      logAuditEvent({
        action: "combo.delete",
        actor,
        target: id,
        resourceType: "combo",
        status: "failure",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: strictRequestId,
        metadata: {
          comboName: existingCombo.name,
          authKind,
          authLabel,
          error: "deleteCombo returned false",
        },
      });
      return comboErrorResponse("COMBO_007", 404, { id }, request);
    }

    logAuditEvent({
      action: "combo.delete",
      actor,
      target: id,
      resourceType: "combo",
      status: "success",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: strictRequestId,
      metadata: {
        comboName: existingCombo.name,
        before: existingCombo,
        after: null,
        authKind,
        authLabel,
      },
    });

    // Auto sync to Cloud if enabled
    await syncToCloudIfEnabled();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return comboErrorResponse("INTERNAL_001", 500, undefined, request);
  }
}

/**
 * Sync to Cloud if enabled
 */
async function syncToCloudIfEnabled() {
  try {
    const cloudEnabled = await isCloudEnabled();
    if (!cloudEnabled) return;

    const machineId = await getConsistentMachineId();
    await syncToCloud(machineId);
  } catch (error) {
    console.log("Error syncing to cloud:", error);
  }
}
