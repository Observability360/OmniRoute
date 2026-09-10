/**
 * Production bug (2026-09-10): /api/oauth/[provider]/[action] is classified
 * MANAGEMENT by src/server/authz/classify.ts (same class as /dashboard/*),
 * but the route handler ran its OWN separate, older auth gate
 * (requireOAuthRouteAuth -> isAuthenticated/isDashboardSessionAuthenticated)
 * instead of the canonical requireManagementAuth() every other MANAGEMENT
 * route uses. That old gate only recognizes an app-native `auth_token`
 * cookie or a Bearer API key — it has zero awareness of Cloudflare Access.
 * On a deployment with no app-native login (Cloudflare Access + Google OIDC
 * as the only auth layer), this meant `authorize` (and every other action on
 * this route) ALWAYS 401'd, even for a real, freshly-authenticated
 * Cloudflare Access session — reproduced live: HTTP 401 on
 * /api/oauth/claude/authorize despite a valid, unexpired
 * Cf-Access-Jwt-Assertion-backed session.
 *
 * Fix: route now calls the shared requireManagementAuth() (src/lib/api/
 * requireManagementAuth.ts), the same gate every other MANAGEMENT-classified
 * route already uses — it recognizes a valid Cloudflare Access assertion in
 * addition to dashboard sessions and manage-scoped API keys.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const TEAM_DOMAIN = "test-team.cloudflareaccess.example";
const AUD = "test-aud-tag-1234567890abcdef";
const ISSUER = `https://${TEAM_DOMAIN}`;
const JWKS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-oauth-cf-access-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// Forces isAuthRequired() to return true (src/shared/utils/apiAuth.ts) without
// touching the settings DB: no password/OIDC ever configured in this fresh
// DB, but INITIAL_PASSWORD alone already fails the "auth not required"
// bypass condition, so the route must actually gate on something.
process.env.INITIAL_PASSWORD = "test-initial-password";
process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
process.env.CLOUDFLARE_ACCESS_AUD = AUD;

const core = await import("../../src/lib/db/core.ts");
const cloudflareAccess = await import("../../src/server/authz/cloudflareAccess.ts");
const route = await import("../../src/app/api/oauth/[provider]/[action]/route.ts");

const originalFetch = globalThis.fetch;

test.beforeEach(() => {
  cloudflareAccess.cloudflareAccessInternals.clearJwksCache();
  globalThis.fetch = originalFetch;
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.INITIAL_PASSWORD;
  delete process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
  delete process.env.CLOUDFLARE_ACCESS_AUD;
  globalThis.fetch = originalFetch;
});

async function makeSignedAssertion(email: string) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = "test-key-1";
  const assertion = await new SignJWT({ iss: ISSUER, aud: AUD, email, email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const jwk = await exportJWK(publicKey);
  return { assertion, jwks: { keys: [{ ...jwk, kid }] } };
}

function mockJwksFetch(jwks: { keys: unknown[] }) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url === JWKS_URL) {
      return new Response(JSON.stringify(jwks), { status: 200 });
    }
    return new Response("not mocked", { status: 404 });
  }) as unknown as typeof fetch;
}

function authorizeRequest(provider: string, assertion?: string) {
  const headers = new Headers();
  if (assertion) headers.set("Cf-Access-Jwt-Assertion", assertion);
  const url = `http://localhost/api/oauth/${provider}/authorize?redirect_uri=${encodeURIComponent("http://localhost:8080/callback")}`;
  return route.GET(new Request(url, { headers }) as unknown as NextRequest, {
    params: Promise.resolve({ provider, action: "authorize" }),
  });
}

test("authorize with no credentials at all is still rejected with 401 (auth genuinely required, not bypassed)", async () => {
  const res = await authorizeRequest("github");
  assert.equal(res.status, 401);
});

test("authorize with an invalid/forged Cloudflare Access assertion is still rejected with 401", async () => {
  const { jwks } = await makeSignedAssertion("a@b.com");
  mockJwksFetch(jwks);
  const forgedKeyPair = await generateKeyPair("RS256");
  const forged = await new SignJWT({ iss: ISSUER, aud: AUD, email: "attacker@evil.example" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(forgedKeyPair.privateKey);

  const res = await authorizeRequest("github", forged);
  assert.equal(res.status, 401);
});

test("authorize with a valid Cloudflare Access assertion is NOT rejected (the actual production bug)", async () => {
  const { assertion, jwks } = await makeSignedAssertion("vinhali@observability360.com.br");
  mockJwksFetch(jwks);

  const res = await authorizeRequest("github", assertion);
  const body = await res.json();

  assert.notEqual(res.status, 401, "a valid, real Cloudflare Access session must never 401 here");
  assert.notEqual(
    body?.error,
    "Unauthorized",
    "must not fail closed on a verified Cloudflare Access identity"
  );
});
