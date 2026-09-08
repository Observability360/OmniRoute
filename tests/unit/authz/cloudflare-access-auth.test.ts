import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const TEAM_DOMAIN = "test-team.cloudflareaccess.example";
const AUD = "test-aud-tag-1234567890abcdef";
const ISSUER = `https://${TEAM_DOMAIN}`;
const JWKS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;

// @ts-ignore - intentional dynamic import: the module reads env vars at call
// time (CLOUDFLARE_ACCESS_TEAM_DOMAIN / CLOUDFLARE_ACCESS_AUD), matching the
// established pattern in this repo's other env-controlled auth tests
// (see tests/unit/oidc-callback.test.ts).
const cloudflareAccess = await import("../../../src/server/authz/cloudflareAccess.ts");

const ORIGINAL_TEAM_DOMAIN = process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
const ORIGINAL_AUD = process.env.CLOUDFLARE_ACCESS_AUD;
const originalFetch = globalThis.fetch;

function configure() {
  process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
  process.env.CLOUDFLARE_ACCESS_AUD = AUD;
}

function unconfigure() {
  delete process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
  delete process.env.CLOUDFLARE_ACCESS_AUD;
}

test.beforeEach(() => {
  cloudflareAccess.cloudflareAccessInternals.clearJwksCache();
  globalThis.fetch = originalFetch;
});

test.after(() => {
  cloudflareAccess.cloudflareAccessInternals.clearJwksCache();
  globalThis.fetch = originalFetch;
  if (ORIGINAL_TEAM_DOMAIN === undefined) delete process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
  else process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN = ORIGINAL_TEAM_DOMAIN;
  if (ORIGINAL_AUD === undefined) delete process.env.CLOUDFLARE_ACCESS_AUD;
  else process.env.CLOUDFLARE_ACCESS_AUD = ORIGINAL_AUD;
});

async function makeSignedAssertion(claims: Record<string, unknown>, opts?: { kid?: string }) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = opts?.kid ?? "test-key-1";
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
    if (url === JWKS_URL) {
      return new Response(JSON.stringify(jwks), { status: 200 });
    }
    return new Response("not mocked", { status: 404 });
  }) as unknown as typeof fetch;
}

function requestWithAssertion(assertion?: string) {
  const headers = new Headers();
  if (assertion) headers.set("Cf-Access-Jwt-Assertion", assertion);
  return new Request("http://localhost/api/combos", { headers });
}

test("not_configured: feature disabled when team domain / aud are unset", async () => {
  unconfigure();
  const verdict = await cloudflareAccess.verifyCloudflareAccessAssertion(
    requestWithAssertion("anything")
  );
  assert.equal(verdict.kind, "not_configured");
});

test("absent: no assertion header on the request", async () => {
  configure();
  const verdict = await cloudflareAccess.verifyCloudflareAccessAssertion(requestWithAssertion());
  assert.equal(verdict.kind, "absent");
});

test("ok: valid signature + issuer + audience + email resolves the verified identity", async () => {
  configure();
  const { assertion, jwks } = await makeSignedAssertion({
    iss: ISSUER,
    aud: AUD,
    email: "Luis@Observability360.com.br",
    email_verified: true,
  });
  mockJwksFetch(jwks);

  const verdict = await cloudflareAccess.verifyCloudflareAccessAssertion(
    requestWithAssertion(assertion)
  );
  assert.equal(verdict.kind, "ok");
  if (verdict.kind === "ok") {
    // normalized: lowercased, trimmed — never the raw claim verbatim.
    assert.equal(verdict.email, "luis@observability360.com.br");
  }
});

test("invalid: wrong signature (assertion signed by a DIFFERENT key than the published JWKS) is rejected", async () => {
  configure();
  const { jwks } = await makeSignedAssertion({ iss: ISSUER, aud: AUD, email: "a@b.com" });
  // Sign a SECOND assertion with an unrelated keypair, but publish the FIRST
  // key's JWKS — simulates a forged/spoofed assertion that never actually
  // passed through Cloudflare's real signing key.
  const { privateKey: forgedKey } = await generateKeyPair("RS256");
  const forged = await new SignJWT({ iss: ISSUER, aud: AUD, email: "attacker@evil.example" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(forgedKey);
  mockJwksFetch(jwks);

  const verdict = await cloudflareAccess.verifyCloudflareAccessAssertion(
    requestWithAssertion(forged)
  );
  assert.equal(verdict.kind, "invalid");
});

test("invalid: expired assertion is rejected", async () => {
  configure();
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = "test-key-1";
  const expired = await new SignJWT({ iss: ISSUER, aud: AUD, email: "a@b.com" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
    .sign(privateKey);
  const jwk = await exportJWK(publicKey);
  mockJwksFetch({ keys: [{ ...jwk, kid }] });

  const verdict = await cloudflareAccess.verifyCloudflareAccessAssertion(
    requestWithAssertion(expired)
  );
  assert.equal(verdict.kind, "invalid");
});

test("invalid: wrong audience is rejected", async () => {
  configure();
  const { assertion, jwks } = await makeSignedAssertion({
    iss: ISSUER,
    aud: "some-other-applications-aud-tag",
    email: "a@b.com",
  });
  mockJwksFetch(jwks);

  const verdict = await cloudflareAccess.verifyCloudflareAccessAssertion(
    requestWithAssertion(assertion)
  );
  assert.equal(verdict.kind, "invalid");
});

test("invalid: wrong issuer is rejected", async () => {
  configure();
  const { assertion, jwks } = await makeSignedAssertion({
    iss: "https://not-the-real-team.cloudflareaccess.example",
    aud: AUD,
    email: "a@b.com",
  });
  mockJwksFetch(jwks);

  const verdict = await cloudflareAccess.verifyCloudflareAccessAssertion(
    requestWithAssertion(assertion)
  );
  assert.equal(verdict.kind, "invalid");
});

test("invalid: missing email claim is rejected even with a valid signature", async () => {
  configure();
  const { assertion, jwks } = await makeSignedAssertion({ iss: ISSUER, aud: AUD });
  mockJwksFetch(jwks);

  const verdict = await cloudflareAccess.verifyCloudflareAccessAssertion(
    requestWithAssertion(assertion)
  );
  assert.equal(verdict.kind, "invalid");
});

test("invalid: malformed (non-JWT) header value is rejected, never throws", async () => {
  configure();
  const verdict = await cloudflareAccess.verifyCloudflareAccessAssertion(
    requestWithAssertion("totally-not-a-jwt")
  );
  assert.equal(verdict.kind, "invalid");
});

test("spoofing protection: a header with the right SHAPE but no valid signature never resolves to ok, regardless of claimed identity", async () => {
  configure();
  // A caller who bypassed Cloudflare entirely and simply guessed the header
  // name, claiming an arbitrary email with no real signing key at all.
  const { privateKey: attackerKey } = await generateKeyPair("RS256");
  const spoofed = await new SignJWT({
    iss: ISSUER,
    aud: AUD,
    email: "ceo@observability360.com.br",
  })
    .setProtectedHeader({ alg: "RS256", kid: "attacker-key" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(attackerKey);

  // The real (never-consulted-by-the-attacker) JWKS only knows about
  // Cloudflare's genuine key — the attacker's key was never published there.
  const { jwks: realJwks } = await makeSignedAssertion({ iss: ISSUER, aud: AUD, email: "x@y.com" });
  mockJwksFetch(realJwks);

  const verdict = await cloudflareAccess.verifyCloudflareAccessAssertion(
    requestWithAssertion(spoofed)
  );
  assert.equal(verdict.kind, "invalid");
});
