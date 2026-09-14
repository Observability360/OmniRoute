import { NextResponse } from "next/server";
import { isAuthRequired, isAuthenticated } from "@/shared/utils/apiAuth";
import { verifyCloudflareAccessAssertion } from "@/server/authz/cloudflareAccess";

/**
 * Shared auth guard for the Cursor deep-control login flow
 * (start / poll / cancel). Previously each route re-implemented this check
 * calling only `isAuthenticated()`, which recognizes the native dashboard
 * session cookie and management API keys but has no knowledge of Cloudflare
 * Access — unlike `managementPolicy` (src/server/authz/policies/management.ts),
 * which has accepted a verified Cloudflare Access identity as equivalent to a
 * dashboard session since that support was added. `/api/oauth/` is
 * PUBLIC-classified in the central authz pipeline (browser OAuth
 * redirect/callback routes elsewhere under this prefix cannot carry auth
 * headers), so these three routes never went through `managementPolicy` and
 * never picked up that fallback: an operator authenticated only via
 * Cloudflare Access (no native password/OIDC login ever completed) got a
 * bare 401 `{"error":"Unauthorized"}` on `start`, even though the dashboard
 * page itself had rendered fine under the same Access session.
 *
 * Fix: accept a verified Cloudflare Access identity here too, using the same
 * `verifyCloudflareAccessAssertion()` used by `managementPolicy` — same JWKS
 * verification, same team-domain/audience pinning, same fail-closed behavior
 * (`not_configured`/`absent`/`invalid` all fall through unchanged to the
 * existing dashboard-session / API-key check below). No new session state,
 * no change to the native login flow, no change to `/v1` or any other
 * provider's auth handling.
 */
export async function requireOAuthAuth(request: Request): Promise<NextResponse | null> {
  if (!(await isAuthRequired(request))) return null;

  const cfAccessVerdict = await verifyCloudflareAccessAssertion(request);
  if (cfAccessVerdict.kind === "ok") return null;

  if (await isAuthenticated(request)) return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
