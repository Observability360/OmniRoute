/**
 * Real caller identity for management-route audit rows (#combo-config-audit
 * follow-up — the incident that motivated this patch was "who/what changed
 * this combo", which a hardcoded actor="admin" can never answer).
 *
 * Sourced from the SAME signals requireManagementAuth() already used to
 * authenticate the request — never invented, never a hardcoded literal.
 *
 * Fast path: the central authz pipeline (src/server/authz/pipeline.ts)
 * stamps AUTHZ_HEADER_AUTH_KIND / _ID / _LABEL on every request it
 * authorizes, before route handlers run. Per AuthSubject's own doc comment
 * (src/server/authz/types.ts) `label` "never includes the raw secret" — this
 * helper only ever reads/forwards those trusted, already-sanitized values or
 * derives an equally safe id (an API key's DB id, never the raw key).
 *
 * Fallback: requests that reach a route handler without going through the
 * pipeline (direct/raw callers, unit tests invoking POST/PUT/DELETE
 * directly) won't carry those headers even though requireManagementAuth()
 * already authenticated them — re-run the same cheap, read-only checks it
 * uses, in the same order, purely to classify which branch authenticated
 * the caller (no new validation logic).
 */
import {
  AUTHZ_HEADER_AUTH_ID,
  AUTHZ_HEADER_AUTH_KIND,
  AUTHZ_HEADER_AUTH_LABEL,
} from "@/server/authz/headers";
import { isAuthRequired, isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { getApiKeyById, getApiKeyMetadata } from "@/lib/db/apiKeys";
import { isCliTokenAuthValid } from "@/lib/middleware/cliTokenAuth";
import { evaluateAccessTokenAuth } from "@/server/authz/accessTokenAuth";
import { isTrustedLoopbackInternalServiceRequest } from "@/lib/api/internalServiceAuth";

export interface ManagementAuditActor {
  /** Human-readable, secret-free caller identity for the audit row's `actor` field. */
  actor: string;
  /** Coarse category — one of "dashboard" | "management-key" | "access-token" |
   *  "local-cli-token" | "trusted-internal-service" | "anonymous" | "unknown". */
  authKind: string;
  /** Optional finer-grained label (e.g. the specific internal-service name). */
  authLabel: string | null;
}

const UNKNOWN_ACTOR: ManagementAuditActor = Object.freeze({
  actor: "unknown-authenticated-management-caller",
  authKind: "unknown",
  authLabel: null,
});

/** Subject ids the authz pipeline mints for internal/service callers (never a real API key id). */
const INTERNAL_SERVICE_SUBJECT_IDS = new Set([
  "ws-bridge",
  "internal-service",
  "model-sync",
  "video-bridge-broker",
  "video-bridge-drilldown",
  "inspector-ingest",
]);

// The "management_key" pipeline-header case has its own sub-branches
// (local CLI token / trusted internal service / access token / a real
// management-key subject) — split out so the parent switch stays flat.
function resolveManagementKeyActor(id: string, label: string | null): ManagementAuditActor {
  if (id === "cli" || label === "local-cli-token") {
    return { actor: "local-cli-token", authKind: "local-cli-token", authLabel: label };
  }
  if (INTERNAL_SERVICE_SUBJECT_IDS.has(id)) {
    return {
      actor: `trusted-internal-service:${label || id}`,
      authKind: "trusted-internal-service",
      authLabel: label,
    };
  }
  if (label && label.startsWith("access-token:")) {
    return { actor: `access-token:${id}`, authKind: "access-token", authLabel: label };
  }
  // A real management/API-key subject — id is the key's DB id (safe).
  return { actor: `management-key:${label || id}`, authKind: "management-key", authLabel: label };
}

function formatFromPipelineHeaders(
  kind: string,
  id: string,
  label: string | null
): ManagementAuditActor {
  switch (kind) {
    case "dashboard_session":
      return {
        actor: id && id !== "dashboard" ? `dashboard:${id}` : "dashboard-session",
        authKind: "dashboard",
        authLabel: label,
      };
    case "anonymous":
      // requireLogin=false / no auth configured — a real, honest governance
      // finding (anyone on this path could have mutated the combo), not the
      // same thing as "unknown". Surface it explicitly.
      return {
        actor: `anonymous:${label || "auth-disabled"}`,
        authKind: "anonymous",
        authLabel: label,
      };
    case "management_key":
      return resolveManagementKeyActor(id, label);
    case "client_api_key":
      // Not expected on MANAGEMENT-class routes, but handle defensively
      // rather than falling through silently.
      return {
        actor: `management-key:${label || id}`,
        authKind: "management-key",
        authLabel: label,
      };
    default:
      return UNKNOWN_ACTOR;
  }
}

// Resolve a friendlier name for a real (non-internal) management-key subject
// when one exists — id alone (a DB id) already satisfies "safe", but a
// human-readable name is nicer for audit review when the row exists.
async function refineManagementKeyActorName(
  formatted: ManagementAuditActor,
  id: string
): Promise<ManagementAuditActor> {
  if (formatted.authKind !== "management-key" || !id) return formatted;
  try {
    const row = await getApiKeyById(id);
    if (row?.name) return { ...formatted, actor: `management-key:${row.name}` };
  } catch {
    // DB lookup failed — keep the id-based actor already computed above.
  }
  return formatted;
}

// Fallback path — pipeline headers absent (direct caller / test harness).
// Re-runs requireManagementAuth()'s own checks, in the same order, purely to
// classify which branch authenticated the caller (no new validation logic).
async function resolveManagementAuditActorFallback(
  request: Request
): Promise<ManagementAuditActor> {
  // Mirror managementPolicy's own Tier 2 bypass (requireLogin=false / no
  // password or OIDC configured): every management caller on this path is
  // genuinely anonymous — a real governance fact, not "unknown".
  if (!(await isAuthRequired(request))) {
    return { actor: "anonymous:auth-disabled", authKind: "anonymous", authLabel: "auth-disabled" };
  }

  if (await isDashboardSessionAuthenticated(request)) {
    return { actor: "dashboard-session", authKind: "dashboard", authLabel: null };
  }

  if (isTrustedLoopbackInternalServiceRequest(request)) {
    return {
      actor: "trusted-internal-service:internal-service-token",
      authKind: "trusted-internal-service",
      authLabel: "internal-service-token",
    };
  }

  if (await isCliTokenAuthValid(request)) {
    return { actor: "local-cli-token", authKind: "local-cli-token", authLabel: "local-cli-token" };
  }

  const accessVerdict = evaluateAccessTokenAuth(request);
  if (accessVerdict.kind === "ok") {
    const subject = accessVerdict.name || accessVerdict.id;
    return {
      actor: `access-token:${subject}`,
      authKind: "access-token",
      authLabel: `access-token:${accessVerdict.scope}`,
    };
  }

  const apiKey = extractApiKey(request, { allowUrl: false });
  if (apiKey) {
    try {
      if (await isValidApiKey(apiKey)) {
        const meta = await getApiKeyMetadata(apiKey);
        if (meta) {
          return {
            actor: `management-key:${meta.name || meta.id}`,
            authKind: "management-key",
            authLabel: meta.id,
          };
        }
      }
    } catch {
      // Auth backend unavailable — fall through to the explicit unknown
      // marker below rather than letting an audit-metadata failure mask as
      // an invented actor.
    }
  }

  // requireManagementAuth() already authenticated this caller (route
  // handlers call it before reaching audit code) via a signal this helper
  // doesn't recognise yet — never silently attribute that to "admin".
  return UNKNOWN_ACTOR;
}

export async function getManagementAuditActor(request: Request): Promise<ManagementAuditActor> {
  const pipelineKind = request.headers.get(AUTHZ_HEADER_AUTH_KIND);
  if (pipelineKind) {
    const id = request.headers.get(AUTHZ_HEADER_AUTH_ID) || "";
    const label = request.headers.get(AUTHZ_HEADER_AUTH_LABEL);
    const formatted = formatFromPipelineHeaders(pipelineKind, id, label);
    return refineManagementKeyActorName(formatted, id);
  }

  // Fallback — pipeline headers absent (direct caller / test harness).
  return resolveManagementAuditActorFallback(request);
}
