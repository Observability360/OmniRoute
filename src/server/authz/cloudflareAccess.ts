import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Verified Cloudflare Access human identity — see cloudflareAccess.ts doc
 * comment for the full trust chain. Reuses the exact `jose` JWKS-verification
 * pattern already used for OIDC login (src/app/api/auth/oidc/callback/route.ts):
 * same library, same createRemoteJWKSet/jwtVerify call shape, different
 * issuer/audience source and a signed assertion header instead of an
 * authorization-code exchange.
 *
 * Cloudflare Access sits in front of this app and, on every request that
 * passes its policy (not just at login), forwards a short-lived
 * `Cf-Access-Jwt-Assertion` header containing the verified identity of the
 * Google Workspace user. Verifying it fresh on every request — rather than
 * minting a local session — means no new session/cookie state is needed and
 * the identity can never outlive the caller's actual Cloudflare Access
 * session.
 *
 * SECURITY: the header's mere presence proves nothing — its name is public
 * and any caller can send an arbitrary value. Trust is established ONLY by
 * verifying the JWT signature against Cloudflare's own JWKS for this
 * team domain, and pinning both `iss` (the team domain) and `aud` (this
 * specific Access application's tag). A request that never passed through
 * Cloudflare Access cannot produce a value that verifies, because it does
 * not hold Cloudflare's private signing key.
 */

export const CF_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export type CloudflareAccessVerdict =
  | { kind: "not_configured" } // team domain / aud not set — feature disabled, caller falls through
  | { kind: "absent" } // no assertion header on this request
  | { kind: "invalid" } // present but failed verification (bad signature, expired, wrong aud/iss, no email)
  | { kind: "ok"; email: string };

// Cache the JWKS client per team domain, mirroring the JWKS caching pattern
// already used for OIDC login — avoids refetching Cloudflare's public keys on
// every request.
const jwksClientsCache: Record<string, ReturnType<typeof createRemoteJWKSet>> = {};

function getJwksClient(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const jwksUri = `https://${teamDomain}/cdn-cgi/access/certs`;
  let client = jwksClientsCache[jwksUri];
  if (!client) {
    client = createRemoteJWKSet(new URL(jwksUri));
    jwksClientsCache[jwksUri] = client;
  }
  return client;
}

// Test seam — lets tests inject a fake JWKS client and clear the cache
// between runs. Mirrors oidcCallbackInternals in the OIDC callback route.
export const cloudflareAccessInternals = {
  clearJwksCache() {
    for (const key of Object.keys(jwksClientsCache)) {
      delete jwksClientsCache[key];
    }
  },
};

function readTeamDomain(): string {
  return (process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN || "").trim().replace(/\/$/, "");
}

function readAudience(): string {
  return (process.env.CLOUDFLARE_ACCESS_AUD || "").trim();
}

/**
 * Verify the request's `Cf-Access-Jwt-Assertion` header, if present, against
 * Cloudflare's JWKS for the configured team domain. Never throws — any
 * verification failure (bad signature, expired, wrong issuer/audience,
 * malformed token, missing/unverified email claim) resolves to `{kind:
 * "invalid"}`, never to `{kind: "ok"}` with a guessed/partial identity.
 */
export async function verifyCloudflareAccessAssertion(
  request: Request
): Promise<CloudflareAccessVerdict> {
  const teamDomain = readTeamDomain();
  const audience = readAudience();
  if (!teamDomain || !audience) {
    return { kind: "not_configured" };
  }

  const assertion = request.headers.get(CF_ACCESS_JWT_HEADER);
  if (!assertion) {
    return { kind: "absent" };
  }

  try {
    const JWKS = getJwksClient(teamDomain);
    const { payload } = await jwtVerify(assertion, JWKS, {
      issuer: `https://${teamDomain}`,
      audience,
    });

    const emailVerified = (payload as Record<string, unknown>).email !== undefined;
    const email =
      emailVerified && typeof (payload as Record<string, unknown>).email === "string"
        ? ((payload as Record<string, unknown>).email as string).trim().toLowerCase()
        : "";

    if (!email) {
      return { kind: "invalid" };
    }

    return { kind: "ok", email };
  } catch {
    return { kind: "invalid" };
  }
}
