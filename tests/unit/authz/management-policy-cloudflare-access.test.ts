import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT, generateKeyPair, exportJWK } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-mgmt-policy-cfa-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const cloudflareAccess = await import("../../../src/server/authz/cloudflareAccess.ts");

const TEAM_DOMAIN = "test-team.cloudflareaccess.example";
const AUD = "test-aud-tag-1234567890abcdef";
const ISSUER = `https://${TEAM_DOMAIN}`;
const JWKS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;

const ORIGINAL_JWT = process.env.JWT_SECRET;
const ORIGINAL_INITIAL = process.env.INITIAL_PASSWORD;
const ORIGINAL_TEAM_DOMAIN = process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
const ORIGINAL_AUD = process.env.CLOUDFLARE_ACCESS_AUD;
const originalFetch = globalThis.fetch;

function reset() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  delete process.env.JWT_SECRET;
  delete process.env.INITIAL_PASSWORD;
  delete process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
  delete process.env.CLOUDFLARE_ACCESS_AUD;
  cloudflareAccess.cloudflareAccessInternals.clearJwksCache();
  globalThis.fetch = originalFetch;
}

test.beforeEach(() => {
  reset();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  globalThis.fetch = originalFetch;
  if (ORIGINAL_JWT === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT;
  if (ORIGINAL_INITIAL === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL;
  if (ORIGINAL_TEAM_DOMAIN === undefined) delete process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
  else process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN = ORIGINAL_TEAM_DOMAIN;
  if (ORIGINAL_AUD === undefined) delete process.env.CLOUDFLARE_ACCESS_AUD;
  else process.env.CLOUDFLARE_ACCESS_AUD = ORIGINAL_AUD;
});

async function loadPolicy() {
  const mod = await import(`../../../src/server/authz/policies/management.ts?ts=${Date.now()}`);
  return mod.managementPolicy;
}

function ctx(headers: Headers, method = "GET", path = "/api/combos") {
  return {
    request: { method, headers, url: `http://localhost${path}`, nextUrl: { pathname: path } },
    classification: {
      routeClass: "MANAGEMENT" as const,
      reason: "management_api" as const,
      normalizedPath: path,
    },
    requestId: "req_test",
  };
}

async function requireLoginOn() {
  process.env.JWT_SECRET = "test-jwt-secret";
  process.env.INITIAL_PASSWORD = "initial-pass";
  await settingsDb.updateSettings({ requireLogin: true });
}

async function makeSignedAssertion(claims: Record<string, unknown>) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = "test-key-1";
  const assertion = await new SignJWT(claims)
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
    if (url === JWKS_URL) return new Response(JSON.stringify(jwks), { status: 200 });
    return new Response("not mocked", { status: 404 });
  }) as unknown as typeof fetch;
}

function configureCloudflareAccess() {
  process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
  process.env.CLOUDFLARE_ACCESS_AUD = AUD;
}

test("requireLogin=true, no credentials at all -> still rejected 401 (unaffected baseline)", async () => {
  await requireLoginOn();
  const policy = await loadPolicy();
  const out = await policy.evaluate(ctx(new Headers()));
  assert.equal(out.allow, false);
  if (!out.allow) assert.equal(out.status, 401);
});

test("requireLogin=true, valid Cloudflare Access assertion -> allowed as workspace_identity with the real email", async () => {
  await requireLoginOn();
  configureCloudflareAccess();
  const { assertion, jwks } = await makeSignedAssertion({
    iss: ISSUER,
    aud: AUD,
    email: "luis@observability360.com.br",
    email_verified: true,
  });
  mockJwksFetch(jwks);

  const headers = new Headers();
  headers.set("Cf-Access-Jwt-Assertion", assertion);
  const policy = await loadPolicy();
  const out = await policy.evaluate(ctx(headers));

  assert.equal(out.allow, true);
  if (out.allow) {
    assert.equal(out.subject.kind, "workspace_identity");
    assert.equal(out.subject.id, "luis@observability360.com.br");
    assert.equal(out.subject.label, "cloudflare-access");
  }
});

test("requireLogin=true, garbage/forged Cloudflare Access header -> still rejected (never trusted on shape alone)", async () => {
  await requireLoginOn();
  configureCloudflareAccess();
  // A real JWKS is published, but the header value is not a valid JWT at all —
  // simulates a caller who bypassed Cloudflare and just guessed the header name.
  const { jwks } = await makeSignedAssertion({ iss: ISSUER, aud: AUD, email: "a@b.com" });
  mockJwksFetch(jwks);

  const headers = new Headers();
  headers.set("Cf-Access-Jwt-Assertion", "garbage-not-a-jwt");
  const policy = await loadPolicy();
  const out = await policy.evaluate(ctx(headers));

  assert.equal(out.allow, false);
  if (!out.allow) assert.equal(out.status, 401);
});

test("requireLogin=true, Cloudflare Access not configured -> falls through unaffected to existing 401", async () => {
  await requireLoginOn();
  // Deliberately do NOT call configureCloudflareAccess().
  const headers = new Headers();
  headers.set("Cf-Access-Jwt-Assertion", "irrelevant-anything");
  const policy = await loadPolicy();
  const out = await policy.evaluate(ctx(headers));

  assert.equal(out.allow, false);
  if (!out.allow) assert.equal(out.status, 401);
});

test("requireLogin=false, anonymous bypass still works unaffected", async () => {
  await settingsDb.updateSettings({ requireLogin: true, password: null });
  const policy = await loadPolicy();
  const out = await policy.evaluate(ctx(new Headers()));
  assert.equal(out.allow, true);
  if (out.allow) assert.equal(out.subject.kind, "anonymous");
});
