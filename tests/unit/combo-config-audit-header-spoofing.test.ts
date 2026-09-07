/**
 * O360 combo-config-audit — header-spoofing protection (#combo-config-audit
 * follow-up, requirement 7: "confirmar que o path real do middleware remove
 * client-supplied x-omniroute-auth-* antes de stampá-los novamente; não
 * aceitar header spoofing como actor real").
 *
 * getManagementAuditActor() trusts the x-omniroute-auth-kind/-id/-label
 * headers when present, on the assumption that the central authz pipeline
 * (src/server/authz/pipeline.ts) already stripped any client-supplied value
 * and re-stamped the real, server-computed subject before a request reaches
 * a route handler. This test exercises the REAL pipeline (not a stand-in)
 * to prove that assumption holds: a request presenting a valid dashboard
 * session cookie AND a spoofed x-omniroute-auth-kind/-id claiming a
 * privileged management_key subject must have the pipeline's own
 * dashboard_session verdict — never the spoofed value — reach the route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-combo-audit-header-spoofing-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "combo-audit-header-spoofing-test-secret";
process.env.INITIAL_PASSWORD = "combo-audit-header-spoofing-test-password";

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const pipeline = await import("../../src/server/authz/pipeline.ts");
const { AUTHZ_HEADER_AUTH_ID, AUTHZ_HEADER_AUTH_KIND, AUTHZ_HEADER_AUTH_LABEL } =
  await import("../../src/server/authz/headers.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function dashboardCookie(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const jwt = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
  return `auth_token=${jwt}`;
}

test("the authz pipeline strips a client-supplied x-omniroute-auth-* header and re-stamps the real subject, never the spoofed one", async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  const cookie = await dashboardCookie();

  const req = new NextRequest("http://localhost/api/combos", {
    headers: {
      cookie,
      // A caller spoofing a privileged management_key subject alongside a
      // genuinely valid (but merely dashboard_session-level) credential.
      [AUTHZ_HEADER_AUTH_KIND]: "management_key",
      [AUTHZ_HEADER_AUTH_ID]: "spoofed-super-admin",
      [AUTHZ_HEADER_AUTH_LABEL]: "spoofed-label",
    },
  });

  const response = await pipeline.runAuthzPipeline(req, { enforce: true });
  assert.equal(response.status, 200, "a valid dashboard session must be allowed through");

  // Next.js encodes the pipeline's forwarded (post-strip, re-stamped) request
  // headers as x-middleware-request-<name> response headers — this is the
  // real mechanism runAuthzPipeline uses (NextResponse.next({request:{headers}})),
  // not a test-only shortcut.
  const forwardedKind = response.headers.get(`x-middleware-request-${AUTHZ_HEADER_AUTH_KIND}`);
  const forwardedId = response.headers.get(`x-middleware-request-${AUTHZ_HEADER_AUTH_ID}`);
  const forwardedLabel = response.headers.get(`x-middleware-request-${AUTHZ_HEADER_AUTH_LABEL}`);

  assert.equal(
    forwardedKind,
    "dashboard_session",
    "the real, server-computed subject kind must reach the route — never the spoofed 'management_key'"
  );
  assert.notEqual(forwardedKind, "management_key");
  assert.notEqual(
    forwardedId,
    "spoofed-super-admin",
    "the spoofed auth-id must never survive to the route handler"
  );
  assert.notEqual(forwardedLabel, "spoofed-label");
});

test("an unauthenticated request cannot use a spoofed x-omniroute-auth-* header to bypass management auth", async () => {
  await settingsDb.updateSettings({ requireLogin: true });

  const req = new NextRequest("http://localhost/api/combos", {
    headers: {
      // No real credential at all — only the spoofed trusted headers.
      [AUTHZ_HEADER_AUTH_KIND]: "management_key",
      [AUTHZ_HEADER_AUTH_ID]: "spoofed-super-admin",
    },
  });

  const response = await pipeline.runAuthzPipeline(req, { enforce: true });
  assert.equal(
    response.status,
    401,
    "a spoofed auth-kind header with no real credential must still be rejected"
  );
});
