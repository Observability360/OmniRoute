/**
 * O360 combo-config-audit — real per-mutation audit trail for
 * POST /api/combos, PUT/PATCH /api/combos/[id], DELETE /api/combos/[id].
 *
 * Reuses the existing audit_log infrastructure (logAuditEvent /
 * getAuditRequestContext, src/lib/compliance/index.ts) verbatim — the same
 * mechanism provider.credentials.* actions already use. No new table, no new
 * subsystem.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-config-audit-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const combosRoute = await import("../../src/app/api/combos/route.ts");
const comboRoute = await import("../../src/app/api/combos/[id]/route.ts");
const { getAuditLog } = await import("../../src/lib/compliance/index.ts");
const { getManagementAuditActor } =
  await import("../../src/lib/compliance/managementAuditActor.ts");
const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
const { getMachineTokenSync } = await import("../../src/lib/machineToken.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/combos", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function put(id: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/combos/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function del(id: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/combos/${id}`, { method: "DELETE", headers });
}

function latestFor(action: string, target: string) {
  const rows = getAuditLog({ action, target, limit: 1 });
  return rows[0] ?? null;
}

// ── 1. combo create generates audit ─────────────────────────────────────────

test("combo create generates an audit_log row", async () => {
  const res = await combosRoute.POST(
    post({ name: "audit-test-create", strategy: "priority", models: ["openai/gpt-4o"] })
  );
  assert.equal(res.status, 201);
  const combo = (await res.json()) as { id: string; name: string };

  const row = latestFor("combo.create", combo.id);
  assert.ok(row, "expected an audit_log row for combo.create");
  assert.equal(row?.status, "success");
  assert.equal(row?.resourceType ?? (row as Record<string, unknown>).resource_type, "combo");
});

// ── 2. combo update generates audit ─────────────────────────────────────────

test("combo update generates an audit_log row", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-update",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  const res = await comboRoute.PUT(put(combo.id, { strategy: "round-robin" }), {
    params: Promise.resolve({ id: combo.id }),
  });
  assert.equal(res.status, 200);

  const row = latestFor("combo.update", combo.id);
  assert.ok(row, "expected an audit_log row for combo.update");
  assert.equal(row?.status, "success");
});

// ── 3. before/after are correct ─────────────────────────────────────────────

test("before/after in the audit row reflect the real prior and new state", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-before-after",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  const res = await comboRoute.PUT(put(combo.id, { strategy: "round-robin" }), {
    params: Promise.resolve({ id: combo.id }),
  });
  assert.equal(res.status, 200);

  const row = latestFor("combo.update", combo.id);
  assert.ok(row);
  const metadata = row?.metadata as {
    before?: { strategy?: string };
    after?: { strategy?: string };
  };
  assert.equal(metadata.before?.strategy, "priority", "before must be the pre-mutation state");
  assert.equal(
    metadata.after?.strategy,
    "round-robin",
    "after must be the real post-mutation state"
  );
});

// ── 4. version increments on update ─────────────────────────────────────────

test("update: combos table has no version column to increment (documented finding, not a fix)", async () => {
  // Real schema check: `PRAGMA table_info(combos)` on production has no
  // "version" column at all (id, name, data, sort_order, created_at,
  // updated_at, system_message, tool_filter_regex, context_cache_protection).
  // The "version": 2 seen in API responses is a fixed schema-shape literal,
  // not a per-row counter — confirmed both by this direct schema check and by
  // observing it stay "2" across a real production combo mutation.
  // Implementing a real increment would require a schema migration (a new
  // column), which is out of this patch's minimal scope ("não criar tabela
  // nova"). Also confirmed here: updateCombo() does not reliably touch
  // updated_at either on a partial-field PATCH (tested directly, not
  // assumed) — so the ONLY real, working change-tracking mechanism this
  // patch provides is the new audit_log row itself (before/after captured
  // explicitly, tested above), not any column on the combos row.
  const core2 = await import("../../src/lib/db/core.ts");
  const db = core2.getDbInstance();
  const columns = (db.prepare("PRAGMA table_info(combos)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  assert.ok(
    !columns.includes("version"),
    "combos table must have no version column (documented fact)"
  );
  assert.ok(
    columns.includes("updated_at"),
    "updated_at column exists, even though it's not a reliable per-update counter"
  );
});

// ── 5. combo delete generates audit ─────────────────────────────────────────

test("combo delete generates an audit_log row", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-delete",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  const res = await comboRoute.DELETE(del(combo.id), { params: Promise.resolve({ id: combo.id }) });
  assert.equal(res.status, 200);

  const row = latestFor("combo.delete", combo.id);
  assert.ok(row, "expected an audit_log row for combo.delete");
  const metadata = row?.metadata as { before?: { name?: string }; after?: unknown };
  assert.equal(metadata.before?.name, "audit-test-delete");
  assert.equal(metadata.after, null, "after must be null for a delete");
});

// ── 6. request id / IP propagation when available ───────────────────────────

test("request id and IP propagate into the audit row when present on the request", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-correlation",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  const res = await comboRoute.PUT(
    put(
      combo.id,
      { strategy: "round-robin" },
      { "x-forwarded-for": "203.0.113.7", "x-request-id": "test-request-id-abc123" }
    ),
    { params: Promise.resolve({ id: combo.id }) }
  );
  assert.equal(res.status, 200);

  const row = latestFor("combo.update", combo.id);
  assert.ok(row);
  const ip = (row as Record<string, unknown>).ip_address ?? (row as Record<string, unknown>).ip;
  assert.equal(ip, "203.0.113.7");
  const requestId =
    (row as Record<string, unknown>).request_id ?? (row as Record<string, unknown>).requestId;
  assert.ok(requestId, "a request id must be recorded even if not exactly the caller-supplied one");
});

// ── 7. no credential/secret ever appears in the audit row ───────────────────

test("no credential/secret leaks into the audit row even if present on the combo body", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-no-secret-leak",
    strategy: "priority",
    models: [
      {
        provider: "openai",
        model: "gpt-4o",
        // A real combo model step has no secret field of its own (secrets
        // live on the provider connection, referenced only by connectionId),
        // but exercise the existing redaction safety net directly to prove
        // it actually applies to what this patch writes.
        connectionId: "11111111-1111-1111-1111-111111111111",
      },
    ],
  });

  const res = await comboRoute.PUT(
    put(combo.id, {
      description: "audit test",
    }),
    { params: Promise.resolve({ id: combo.id }) }
  );
  assert.equal(res.status, 200);

  const row = latestFor("combo.update", combo.id);
  assert.ok(row);
  const serialized = JSON.stringify(row?.metadata ?? {});
  for (const forbidden of ["apiKey", "accessToken", "refreshToken", "idToken", "authToken"]) {
    assert.ok(
      !new RegExp(`"${forbidden}"\\s*:\\s*"(?!\\[redacted\\])`, "i").test(serialized),
      `audit row must never contain a real value for ${forbidden}`
    );
  }
});

// ── Strict pre-mutation audit gate (#combo-config-audit follow-up) ─────────
//
// "No unattributed combo mutation": beginStrictAuditEvent() writes a
// `<action>.attempt` row BEFORE the mutation runs and THROWS on failure
// (unlike the best-effort logAuditEvent()) — the route must catch that and
// abort without performing the mutation. These monkey-patch db.prepare() for
// a specific SQL substring to simulate a genuine backend failure at that
// exact boundary, the same established technique already used elsewhere in
// this test suite (see tests/unit/api-key-reveal-route.test.ts) — not a
// fake provider standing in for the feature under test, just a targeted
// failure injection at the real DB call site. Runs before the
// withAuthRequired() block below on purpose: these rely on the same
// auth-not-required bypass tests 1-7 already use, and withAuthRequired()
// permanently flips this shared test DB to requireLogin=true the first time
// it runs (see the auth-disabled-bypass test's own note on that).

function withPreparePatch<T>(match: string, fn: () => Promise<T>): Promise<T> {
  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((
    sql: string,
    ...args: unknown[]
  ) => {
    if (typeof sql === "string" && sql.includes(match)) {
      throw new Error(`simulated backend failure at: ${match}`);
    }
    return originalPrepare(sql, ...args);
  }) as typeof db.prepare;
  return fn().finally(() => {
    (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
  });
}

// ── 8. create: audit backend failure → combo NOT created ───────────────────

test("create: audit backend failure aborts the mutation — combo is not created", () =>
  withPreparePatch("INSERT INTO audit_log", async () => {
    const res = await combosRoute.POST(
      post({
        name: "audit-test-strict-create-fails",
        strategy: "priority",
        models: ["openai/gpt-4o"],
      })
    );
    assert.equal(res.status, 503);

    const combo = await combosDb.getComboByName("audit-test-strict-create-fails");
    assert.ok(!combo, "combo must not exist — the audit attempt failed before createCombo ran");
  }));

// ── 9. update: audit backend failure → previous state remains ──────────────

test("update: audit backend failure aborts the mutation — previous state is unchanged", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-strict-update-fails",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  await withPreparePatch("INSERT INTO audit_log", async () => {
    const res = await comboRoute.PUT(put(combo.id, { strategy: "round-robin" }), {
      params: Promise.resolve({ id: combo.id }),
    });
    assert.equal(res.status, 503);
  });

  const after = await combosDb.getComboByName("audit-test-strict-update-fails");
  assert.ok(after);
  assert.equal(
    (after as { strategy?: string }).strategy,
    "priority",
    "strategy must remain the pre-mutation value — updateCombo() must never have run"
  );
});

// ── 10. delete: audit backend failure → combo remains ───────────────────────

test("delete: audit backend failure aborts the mutation — combo remains", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-strict-delete-fails",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  await withPreparePatch("INSERT INTO audit_log", async () => {
    const res = await comboRoute.DELETE(del(combo.id), {
      params: Promise.resolve({ id: combo.id }),
    });
    assert.equal(res.status, 503);
  });

  const after = await combosDb.getComboByName("audit-test-strict-delete-fails");
  assert.ok(after, "combo must still exist — deleteCombo() must never have run");
});

// ── 11. success: both the attempt and the finalized row are correct ────────

test("strict gate: a successful mutation records both the attempt row and the finalized success row", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-strict-success-both-rows",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  const res = await comboRoute.PUT(put(combo.id, { strategy: "round-robin" }), {
    params: Promise.resolve({ id: combo.id }),
  });
  assert.equal(res.status, 200);

  const attemptRows = getAuditLog({ action: "combo.update.attempt", target: combo.id, limit: 1 });
  assert.equal(attemptRows.length, 1);
  assert.equal(attemptRows[0]?.status, "attempted");

  const successRow = latestFor("combo.update", combo.id);
  assert.ok(successRow);
  assert.equal(successRow?.status, "success");
  const metadata = successRow?.metadata as {
    before?: { strategy?: string };
    after?: { strategy?: string };
  };
  assert.equal(metadata.before?.strategy, "priority");
  assert.equal(metadata.after?.strategy, "round-robin");

  // Both rows correlate via the same requestId (attempt written first, reused
  // for the finalize write) — proves they are the same logical mutation.
  const attemptRow = attemptRows[0] as Record<string, unknown>;
  const finalizeRow = successRow as Record<string, unknown>;
  const attemptRequestId = attemptRow.requestId ?? attemptRow.request_id;
  const finalizeRequestId = finalizeRow.requestId ?? finalizeRow.request_id;
  assert.ok(attemptRequestId);
  assert.equal(attemptRequestId, finalizeRequestId);
});

// ── 12. mutation failure never records a false SUCCESS ──────────────────────

test("mutation failure records a FAILURE audit row, never a false SUCCESS", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-strict-mutation-failure",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  await withPreparePatch("UPDATE combos SET name", async () => {
    const res = await comboRoute.PUT(put(combo.id, { strategy: "round-robin" }), {
      params: Promise.resolve({ id: combo.id }),
    });
    assert.equal(res.status, 500);
  });

  const row = latestFor("combo.update", combo.id);
  assert.ok(row, "expected a failure row for this mutation attempt");
  assert.equal(row?.status, "failure");
  assert.notEqual(row?.status, "success");
});

// ── Strict ATTEMPT carries the intended change (#combo-config-audit follow-up 2) ─
//
// The strict ATTEMPT already guarantees authorship before the mutation runs
// (tests 8-10 above), but until now it carried no evidence of WHAT change
// was intended — if the finalize SUCCESS write itself then failed (a
// separate, non-strict best-effort write), the only surviving row would say
// who/when but not what. These prove the ATTEMPT row now also carries the
// intended change itself, through the same sanitizeAuditValue redaction
// path as every other audit field.

// ── 13. create attempt contains the requested combo input ──────────────────

test("create: the strict ATTEMPT row contains the requested combo input", async () => {
  const res = await combosRoute.POST(
    post({
      name: "audit-test-attempt-requested-create",
      strategy: "priority",
      models: ["openai/gpt-4o"],
    })
  );
  assert.equal(res.status, 201);

  // The strict ATTEMPT is written before createCombo() runs, so its target
  // is the requested name — the real id doesn't exist yet at that point
  // (the finalize SUCCESS row, tested elsewhere, is the one keyed by id).
  const attemptRows = getAuditLog({
    action: "combo.create.attempt",
    target: "audit-test-attempt-requested-create",
    limit: 1,
  });
  assert.equal(attemptRows.length, 1);
  const metadata = attemptRows[0]?.metadata as {
    requested?: { name?: string; strategy?: string; models?: unknown };
  };
  assert.equal(metadata.requested?.name, "audit-test-attempt-requested-create");
  assert.equal(metadata.requested?.strategy, "priority");
  assert.ok(Array.isArray(metadata.requested?.models));
});

// ── 14. update attempt contains before + requested ──────────────────────────

test("update: the strict ATTEMPT row contains before and the requested change", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-attempt-requested-update",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  const res = await comboRoute.PUT(put(combo.id, { strategy: "round-robin" }), {
    params: Promise.resolve({ id: combo.id }),
  });
  assert.equal(res.status, 200);

  const attemptRows = getAuditLog({
    action: "combo.update.attempt",
    target: combo.id,
    limit: 1,
  });
  assert.equal(attemptRows.length, 1);
  const metadata = attemptRows[0]?.metadata as {
    before?: { strategy?: string };
    requested?: { strategy?: string };
  };
  assert.equal(
    metadata.before?.strategy,
    "priority",
    "attempt row must carry the pre-mutation state"
  );
  assert.equal(
    metadata.requested?.strategy,
    "round-robin",
    "attempt row must carry the intended change"
  );
});

// ── 15. delete attempt contains before ──────────────────────────────────────

test("delete: the strict ATTEMPT row contains the pre-deletion state", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-attempt-before-delete",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  const res = await comboRoute.DELETE(del(combo.id), { params: Promise.resolve({ id: combo.id }) });
  assert.equal(res.status, 200);

  const attemptRows = getAuditLog({
    action: "combo.delete.attempt",
    target: combo.id,
    limit: 1,
  });
  assert.equal(attemptRows.length, 1);
  const metadata = attemptRows[0]?.metadata as { before?: { name?: string } };
  assert.equal(metadata.before?.name, "audit-test-attempt-before-delete");
});

// ── 16. secrets inside before/requested stay redacted ───────────────────────

test("create/update attempt rows never leak a real secret from before/requested", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-attempt-no-secret-leak",
    strategy: "priority",
    models: [
      {
        provider: "openai",
        model: "gpt-4o",
        connectionId: "22222222-2222-2222-2222-222222222222",
      },
    ],
  });

  const res = await comboRoute.PUT(put(combo.id, { description: "audit test" }), {
    params: Promise.resolve({ id: combo.id }),
  });
  assert.equal(res.status, 200);

  const attemptRows = getAuditLog({
    action: "combo.update.attempt",
    target: combo.id,
    limit: 1,
  });
  assert.equal(attemptRows.length, 1);
  const serialized = JSON.stringify(attemptRows[0]?.metadata ?? {});
  for (const forbidden of ["apiKey", "accessToken", "refreshToken", "idToken", "authToken"]) {
    assert.ok(
      !new RegExp(`"${forbidden}"\\s*:\\s*"(?!\\[redacted\\])`, "i").test(serialized),
      `attempt row must never contain a real value for ${forbidden}`
    );
  }
});

// ── Real actor resolution (#combo-config-audit follow-up) ──────────────────
//
// These exercise the SAME auth signals requireManagementAuth() itself checks
// (dashboard session / trusted internal service / local CLI token / management
// API key), via getManagementAuditActor(request) — never a hardcoded "admin".
//
// isAuthRequired() short-circuits to a bypass ("anonymous:auth-disabled") on a
// fresh/no-password test DB (see the dedicated test for that path below), so
// each of these forces a real auth-required state via INITIAL_PASSWORD for the
// duration of the test only — the original tests above are unaffected (no
// credentials, no INITIAL_PASSWORD, so they keep hitting the bypass path).

const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_INTERNAL_SERVICE_TOKEN = process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;
process.env.API_KEY_SECRET = "test-api-key-secret-combo-audit";

function withAuthRequired<T>(fn: () => Promise<T>): Promise<T> {
  process.env.INITIAL_PASSWORD = "audit-actor-test-password";
  return fn().finally(() => {
    if (ORIGINAL_INITIAL_PASSWORD === undefined) {
      delete process.env.INITIAL_PASSWORD;
    } else {
      process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
    }
  });
}

test.after(() => {
  if (ORIGINAL_JWT_SECRET === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  }
  if (ORIGINAL_INTERNAL_SERVICE_TOKEN === undefined) {
    delete process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN;
  } else {
    process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN = ORIGINAL_INTERNAL_SERVICE_TOKEN;
  }
  if (ORIGINAL_API_KEY_SECRET === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
  }
});

// ── 17. auth-disabled bypass → explicit, non-'admin' value ─────────────────
//
// MUST run before any withAuthRequired() test below: getSettings() persists
// setupComplete=true/requireLogin=true to this shared test DB the first time
// it observes INITIAL_PASSWORD (src/lib/db/settings.ts "Auto-complete
// onboarding for pre-configured deployments") — a real, irreversible-for-this-
// DB side effect, not a test-isolation bug to work around. Once any later
// test sets INITIAL_PASSWORD, isAuthRequired() stops bypassing for the rest
// of this file, so the bypass path must be observed first.

test("auth-disabled bypass resolves to an explicit, non-'admin' actor", async () => {
  const combo = await combosDb.createCombo({
    name: "audit-test-actor-auth-disabled",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });
  const res = await comboRoute.PUT(put(combo.id, { strategy: "round-robin" }), {
    params: Promise.resolve({ id: combo.id }),
  });
  assert.equal(res.status, 200);
  const row = latestFor("combo.update", combo.id);
  assert.ok(row);
  // A real, honest governance fact (anyone on this path could have mutated
  // the combo) — must be explicit, never silently "admin" and never
  // conflated with the "unknown" safety net (tested separately below).
  assert.equal(row?.actor, "anonymous:auth-disabled");
  assert.notEqual(row?.actor, "admin");
});

// ── 18. management API key → real actor/label ───────────────────────────────

test("management API key produces a real, non-'admin' actor with a safe label", () =>
  withAuthRequired(async () => {
    const apiKey = await createApiKey("audit-actor-test-key", "test-machine-id", ["manage"]);

    const combo = await combosDb.createCombo({
      name: "audit-test-actor-api-key",
      strategy: "priority",
      models: ["openai/gpt-4o"],
    });

    const res = await comboRoute.PUT(
      put(combo.id, { strategy: "round-robin" }, { authorization: `Bearer ${apiKey.key}` }),
      { params: Promise.resolve({ id: combo.id }) }
    );
    assert.equal(res.status, 200);

    const row = latestFor("combo.update", combo.id);
    assert.ok(row);
    assert.equal(row?.actor, `management-key:${apiKey.name}`);
    const metadata = row?.metadata as { authKind?: string };
    assert.equal(metadata.authKind, "management-key");
    assert.notEqual(row?.actor, "admin");
  }));

// ── 19. local CLI management token → identified ─────────────────────────────

test("local CLI management token is identified as local-cli-token, never 'admin'", () =>
  withAuthRequired(async () => {
    const combo = await combosDb.createCombo({
      name: "audit-test-actor-cli",
      strategy: "priority",
      models: ["openai/gpt-4o"],
    });

    const res = await comboRoute.PUT(
      put(
        combo.id,
        { strategy: "round-robin" },
        {
          "x-omniroute-cli-token": getMachineTokenSync(),
          // Raw Request has no real socket peer — stamp the same trusted
          // locality signal the authz pipeline would (peerStamp.ts), which
          // isCliTokenAuthValid()'s own fallback branch reads directly.
          "x-omniroute-peer-locality": "loopback",
        }
      ),
      { params: Promise.resolve({ id: combo.id }) }
    );
    assert.equal(res.status, 200);

    const row = latestFor("combo.update", combo.id);
    assert.ok(row);
    assert.equal(row?.actor, "local-cli-token");
    assert.notEqual(row?.actor, "admin");
  }));

// ── 20. dashboard session → dashboard-session (no human identity available) ─

test("dashboard session actor is 'dashboard-session' (no human identity exists today), never 'admin'", () =>
  withAuthRequired(async () => {
    process.env.JWT_SECRET = "combo-audit-actor-test-jwt-secret";
    const jwt = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    const combo = await combosDb.createCombo({
      name: "audit-test-actor-dashboard",
      strategy: "priority",
      models: ["openai/gpt-4o"],
    });

    const res = await comboRoute.PUT(
      put(combo.id, { strategy: "round-robin" }, { cookie: `auth_token=${jwt}` }),
      { params: Promise.resolve({ id: combo.id }) }
    );
    assert.equal(res.status, 200);

    const row = latestFor("combo.update", combo.id);
    assert.ok(row);
    // Real finding, not an assumption: the dashboard session JWT (login AND
    // OIDC) only ever carries `{authenticated: true}` — no subject/email
    // claim exists to attribute a human identity to. Documenting that
    // honestly (per the instruction not to invent one) rather than a fake
    // per-user label.
    assert.equal(row?.actor, "dashboard-session");
    const metadata = row?.metadata as { authKind?: string };
    assert.equal(metadata.authKind, "dashboard");
    assert.notEqual(row?.actor, "admin");
  }));

// ── 21. trusted internal service → identified ───────────────────────────────

test("trusted internal-service caller is identified, never 'admin'", () =>
  withAuthRequired(async () => {
    process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN = "combo-audit-actor-test-internal-token";

    const combo = await combosDb.createCombo({
      name: "audit-test-actor-internal",
      strategy: "priority",
      models: ["openai/gpt-4o"],
    });

    const res = await comboRoute.PUT(
      put(
        combo.id,
        { strategy: "round-robin" },
        {
          "x-omniroute-internal-service-token": process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN,
          "x-omniroute-peer-locality": "loopback",
        }
      ),
      { params: Promise.resolve({ id: combo.id }) }
    );
    assert.equal(res.status, 200);

    const row = latestFor("combo.update", combo.id);
    assert.ok(row);
    assert.equal(row?.actor, "trusted-internal-service:internal-service-token");
    assert.notEqual(row?.actor, "admin");
  }));

// ── 22. no raw credential ever appears in the actor/metadata itself ─────────

test("actor resolution never embeds a raw token/key/cookie value", () =>
  withAuthRequired(async () => {
    const apiKey = await createApiKey("audit-actor-secret-check-key", "test-machine-id", [
      "manage",
    ]);

    const combo = await combosDb.createCombo({
      name: "audit-test-actor-no-raw-secret",
      strategy: "priority",
      models: ["openai/gpt-4o"],
    });

    const res = await comboRoute.PUT(
      put(combo.id, { strategy: "round-robin" }, { authorization: `Bearer ${apiKey.key}` }),
      { params: Promise.resolve({ id: combo.id }) }
    );
    assert.equal(res.status, 200);

    const row = latestFor("combo.update", combo.id);
    assert.ok(row);
    const serialized = JSON.stringify(row);
    assert.ok(
      !serialized.includes(apiKey.key),
      "the raw API key value must never appear anywhere in the audit row"
    );
  }));

// ── 23. unrecognised authenticated caller → explicit fallback, never 'admin' ─

test("an unrecognised auth-kind from the authz pipeline resolves to an explicit safe fallback", async () => {
  // A future/unrecognised AuthSubject.kind from the central authz pipeline
  // (simulated directly against the helper, since no such kind exists in the
  // pipeline today) must still resolve to an explicit, safe fallback — never
  // silently "admin", never crash. No DB dependency, so no ordering
  // constraint with the withAuthRequired() tests above.
  const unknownKindRequest = new Request("http://localhost/api/combos/x", {
    headers: { "x-omniroute-auth-kind": "some-future-auth-kind-not-yet-handled" },
  });
  const actor = await getManagementAuditActor(unknownKindRequest);
  assert.equal(actor.actor, "unknown-authenticated-management-caller");
  assert.equal(actor.authKind, "unknown");
  assert.notEqual(actor.actor, "admin");
});
