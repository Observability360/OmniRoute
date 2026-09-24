import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveHostedRunnerSwapMb,
  ensureHostedRunnerSwap,
} from "../../../scripts/build/build-next-isolated.mjs";

// The CI Build job lost its GitHub-hosted runner during "Collecting page data" even
// at 1 worker / 6 GB heap (runs 36043043873, 36044427857); build.yml survives the
// same build only because it adds 10 GB swap. The build script now does that itself,
// but ONLY on an ephemeral github-hosted Linux runner.
const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
const onLinux = process.platform === "linux";

describe("hosted-runner build swap", () => {
  it("is off for local builds and self-hosted runners", () => {
    assert.equal(resolveHostedRunnerSwapMb({}), 0);
    assert.equal(
      resolveHostedRunnerSwapMb({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }),
      0
    );
  });

  it("defaults to 10240 MB on a hosted Linux runner and honours the override", () => {
    assert.equal(resolveHostedRunnerSwapMb(hosted), onLinux ? 10240 : 0);
    assert.equal(resolveHostedRunnerSwapMb({ ...hosted, OMNIROUTE_BUILD_SWAP_MB: "0" }), 0);
    assert.equal(resolveHostedRunnerSwapMb({ ...hosted, OMNIROUTE_BUILD_SWAP_MB: "junk" }), 0);
  });

  it("never runs a command when disabled, and passes the size via env (not the script)", () => {
    const calls: unknown[][] = [];
    const fake = (...args: unknown[]) => {
      calls.push(args);
      return { status: 0 };
    };
    assert.equal(ensureHostedRunnerSwap({}, fake as never), false);
    assert.equal(calls.length, 0);

    const ran = ensureHostedRunnerSwap(
      { ...hosted, OMNIROUTE_BUILD_SWAP_MB: "2048" },
      fake as never
    );
    if (!onLinux) {
      assert.equal(ran, false);
      return;
    }
    assert.equal(ran, true);
    const [cmd, argv] = calls[0] as [string, string[]];
    assert.equal(cmd, "sudo");
    assert.deepEqual(argv.slice(0, 3), ["-n", "env", "SWAP_MB=2048"]);
    assert.doesNotMatch(
      argv[argv.length - 1],
      /2048/,
      "size must not be interpolated into the script"
    );
  });

  it("is non-fatal when sudo/swap fails", () => {
    const failing = () => ({ status: 1 });
    assert.equal(ensureHostedRunnerSwap(hosted, failing as never), false);
  });
});
