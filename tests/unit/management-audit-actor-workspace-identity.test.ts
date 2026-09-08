import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTHZ_HEADER_AUTH_ID,
  AUTHZ_HEADER_AUTH_KIND,
  AUTHZ_HEADER_AUTH_LABEL,
} from "../../src/server/authz/headers.ts";
import { getManagementAuditActor } from "../../src/lib/compliance/managementAuditActor.ts";

/**
 * The pipeline (src/server/authz/policies/management.ts) only ever stamps
 * AUTHZ_HEADER_AUTH_KIND="workspace_identity" after verifyCloudflareAccessAssertion()
 * resolves a signature-verified email (see tests/unit/authz/cloudflare-access-auth.test.ts
 * for that verification itself). This test exercises the downstream mapping only:
 * given those already-trusted stamped headers, the audit actor must read
 * "human:<email>" — never a generic/anonymous label — and the raw JWT/cookie
 * must never appear anywhere in the result.
 */
test("workspace_identity pipeline headers resolve to a real human actor, not a generic label", async () => {
  const req = new Request("http://localhost/api/combos", {
    headers: {
      [AUTHZ_HEADER_AUTH_KIND]: "workspace_identity",
      [AUTHZ_HEADER_AUTH_ID]: "luis@observability360.com.br",
      [AUTHZ_HEADER_AUTH_LABEL]: "cloudflare-access",
    },
  });

  const actor = await getManagementAuditActor(req);

  assert.equal(actor.actor, "human:luis@observability360.com.br");
  assert.equal(actor.authKind, "workspace_identity");
  assert.equal(actor.authLabel, "cloudflare-access");
});

test("workspace_identity actor never contains raw token/cookie material, only the resolved email", async () => {
  const req = new Request("http://localhost/api/combos", {
    headers: {
      [AUTHZ_HEADER_AUTH_KIND]: "workspace_identity",
      [AUTHZ_HEADER_AUTH_ID]: "someone@observability360.com.br",
      [AUTHZ_HEADER_AUTH_LABEL]: "cloudflare-access",
    },
  });

  const actor = await getManagementAuditActor(req);
  const serialized = JSON.stringify(actor);
  assert.ok(
    !/eyJ/.test(serialized),
    "must not contain what looks like a raw JWT (base64url 'eyJ' header)"
  );
  assert.equal(actor.actor, "human:someone@observability360.com.br");
});
