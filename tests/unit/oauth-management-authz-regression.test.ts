import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const route = readFileSync(
  join(repoRoot, "src/app/api/oauth/[provider]/[action]/route.ts"),
  "utf8"
);

test("OAuth management routes use the central guard for Cloudflare Access identities", () => {
  assert.match(route, /import \{ requireManagementAuth \} from \"@\/lib\/api\/requireManagementAuth\"/);
  assert.match(route, /return requireManagementAuth\(request, \{ invalidApiKeyStatus: 401 \}\)/);
  assert.doesNotMatch(route, /isAuthenticated\(request\)/);
});
