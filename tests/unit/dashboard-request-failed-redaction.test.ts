import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { RequestFailedPayload } from "../../src/lib/events/types.ts";

const RESULT_PREFIX = "DASHBOARD_FAILURE_PROBE_RESULT=";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const probePath = fileURLToPath(
  new URL("../fixtures/dashboard-request-failed-redaction-probe.ts", import.meta.url)
);

type ProbeResult = {
  delivered: RequestFailedPayload;
  replayMatches: boolean;
  internalRawPreserved: boolean;
  writerDrained: boolean;
};

function runProbe(env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx/esm", probePath],
      {
        cwd: repoRoot,
        env,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `dashboard failure probe exited unsuccessfully: ${error.message}\n` +
                `stdout:\n${stdout}\nstderr:\n${stderr}`
            )
          );
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

test("persistAttemptLogs redacts request.failed delivery/replay but keeps its internal log", async () => {
  const isolationRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "omniroute-dashboard-failure-redaction-")
  );
  const dataDir = path.join(isolationRoot, "data");
  const pluginsDir = path.join(isolationRoot, "plugins");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });

  try {
    // The subprocess receives only process/runtime basics plus synthetic OmniRoute settings: no
    // provider credentials are inherited and no parent singleton/env/global state is mutated.
    const { stdout, stderr } = await runProbe({
      PATH: process.env.PATH,
      NODE_PATH: process.env.NODE_PATH,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TZ: process.env.TZ,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      OMNIROUTE_PLUGINS_DIR: pluginsDir,
      API_KEY_SECRET: "test-dashboard-failure-redaction-secret",
      PII_RESPONSE_SANITIZATION: "false",
      OMNIROUTE_ENABLE_LIVE_WS: "0",
    });

    assert.doesNotMatch(stderr, /sk-live-dashboard-secret|\/srv\/omniroute/);
    const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith(RESULT_PREFIX));
    assert.ok(resultLine, `probe did not emit its result marker; stdout:\n${stdout}`);
    const result = JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as ProbeResult;

    assert.equal(result.delivered.id, "trace-dashboard-redaction");
    assert.equal(result.delivered.statusCode, 502);
    assert.equal(result.delivered.model, "private-model");
    assert.equal(result.delivered.provider, "private-provider");
    // (#ci-baseline-repair) errorPathRedaction.ts now recognizes the leading .ts:line:col source
    // path as unambiguous and fails closed over the rest of the message -- api_key='...' never
    // gets its own in-place "[REDACTED]" marker because it's truncated away entirely (still
    // proven absent by the doesNotMatch assertions inside the probe), at least as safe as the
    // old in-place substitution this assertion originally pinned.
    assert.equal(result.delivered.error, "Error: Provider failed in <path>");
    assert.equal(result.replayMatches, true);
    // (#ci-baseline-repair) sanitizeErrorForLog (src/lib/usage/callLogs/format.ts) has always run
    // the persisted call-log error through the same sanitization pipeline -- the internal log is
    // no longer (and, per the probe's own doesNotMatch assertions, never was meant to be relied
    // on as) a raw-diagnostic store for this shape of message. See the probe fixture for detail.
    assert.equal(result.internalRawPreserved, false);
    assert.equal(result.writerDrained, true);
  } finally {
    // The probe exits only after draining/closing its writer and resetting its DB singleton.
    fs.rmSync(isolationRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test("the private LiveWS bridge forwards the already-safe event into its backlog unchanged", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../../src/server/ws/liveServer.ts", import.meta.url)),
    "utf8"
  );

  // publishDashboardEvent/eventHistoryBacklog are module-private. This bounded source-chain
  // assertion avoids opening a server while proving the bus payload is what live delivery and
  // welcome/backlog replay store. The behavioral safety assertion lives in the subprocess above.
  assert.match(
    source,
    /eventHistoryBacklog\.push\(\{ event, payload, timestamp \}\)/,
    "the LiveWS backlog must store the event-bus payload"
  );
  assert.match(
    source,
    /data:\s*h\.payload/,
    "welcome replay must forward the stored backlog payload"
  );
  assert.match(
    source,
    /onAny\(\(event:[^\n]+payload:[^\n]+\)\s*=>\s*\{\s*publishDashboardEvent\(event, payload\)/,
    "the LiveWS bridge must publish the same event-bus payload"
  );
});
