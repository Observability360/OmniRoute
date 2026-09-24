import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveNextBuildEnv } from "../../../scripts/build/build-next-isolated.mjs";

// The CI `Build` job runs `npm run build` directly on a 16 GB / 4 vCPU GitHub-hosted
// runner. Next 16 then collects page data with os.cpus()-1 = 3 workers at ~4.5 GB RSS
// each (measured in #7518), exhausting the host right after "Collecting page data":
// the runner is shut down ("The runner has received a shutdown signal") and the job
// fails with no build error at all. The Dockerfile already caps this for the image
// build (CIRCLE_NODE_TOTAL=2 → 1 worker); the direct CI path must get the same cap.
describe("page-data worker cap on GitHub-hosted runners", () => {
  const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };

  it("caps page-data collection to 1 worker (CIRCLE_NODE_TOTAL=2) on a hosted runner", () => {
    assert.equal(resolveNextBuildEnv(hosted, "linux").CIRCLE_NODE_TOTAL, "2");
  });

  it("respects an explicit CIRCLE_NODE_TOTAL override", () => {
    const env = resolveNextBuildEnv({ ...hosted, CIRCLE_NODE_TOTAL: "4" }, "linux");
    assert.equal(env.CIRCLE_NODE_TOTAL, "4");
  });

  it("leaves self-hosted runners and local builds untouched", () => {
    const selfHosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" };
    assert.equal(resolveNextBuildEnv(selfHosted, "linux").CIRCLE_NODE_TOTAL, undefined);
    assert.equal(resolveNextBuildEnv({}, "linux").CIRCLE_NODE_TOTAL, undefined);
  });
});
