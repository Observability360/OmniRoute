// O360 explicit-target-routing V1 — alias resolution precedence unit tests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-explicit-target-resolver-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "explicit-target-resolver-secret";

const { resolveExplicitTarget } =
  await import("../../../open-sse/services/combo/explicitTargetResolver.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");

const currentCombo = { name: "o360-coding", strategy: "priority", models: ["cx/codex-a"] };

test("tier 1 — built-in Claude alias resolves to the approved real model without settings", async () => {
  await updateSettings({ explicitTargetAliases: {} });
  const result = await resolveExplicitTarget({
    alias: "Claude",
    combo: currentCombo,
    allCombos: [currentCombo],
  });
  assert.deepEqual(result, {
    status: "resolved",
    matchedVia: "synonym",
    kind: "model",
    modelStr: "cc/claude-sonnet-5",
  });
});

test("tier 1 — Astra remains unresolved until a real GPT-6 target is configured", async () => {
  await updateSettings({ explicitTargetAliases: {} });
  const result = await resolveExplicitTarget({
    alias: "ASTRA",
    combo: currentCombo,
    allCombos: [currentCombo],
  });
  assert.deepEqual(result, { status: "unknown" });
});

test("tier 1 — built-in GLM alias resolves to the confirmed real model", async () => {
  await updateSettings({ explicitTargetAliases: {} });
  const result = await resolveExplicitTarget({
    alias: "GLM",
    combo: currentCombo,
    allCombos: [currentCombo],
  });
  assert.deepEqual(result, {
    status: "resolved",
    matchedVia: "synonym",
    kind: "model",
    modelStr: "zai/glm-4.7-flash",
  });
});

test("tier 1 — settings synonym wins, case-insensitively", async () => {
  await updateSettings({ explicitTargetAliases: { glm: "combo/o360-cheap-worker" } });
  const result = await resolveExplicitTarget({
    alias: "GLM",
    combo: currentCombo,
    allCombos: [currentCombo, { name: "o360-cheap-worker", models: ["zai/glm-5.1"] }],
  });
  assert.deepEqual(result, {
    status: "resolved",
    matchedVia: "synonym",
    kind: "combo",
    comboName: "o360-cheap-worker",
  });
});

test("tier 1 — configured synonym overrides a built-in friendly alias", async () => {
  await updateSettings({ explicitTargetAliases: { astra: "provider-b/model-b" } });
  const result = await resolveExplicitTarget({
    alias: "astra",
    combo: currentCombo,
    allCombos: [currentCombo],
  });
  assert.deepEqual(result, {
    status: "resolved",
    matchedVia: "synonym",
    kind: "model",
    modelStr: "provider-b/model-b",
  });
});

test("tier 2 — exact combo name, case-insensitive, when no synonym matches", async () => {
  await updateSettings({ explicitTargetAliases: {} });
  const allCombos = [currentCombo, { name: "o360-cheap-worker", models: ["zai/glm-5.1"] }];
  const result = await resolveExplicitTarget({
    alias: "O360-CHEAP-WORKER",
    combo: currentCombo,
    allCombos,
  });
  assert.deepEqual(result, {
    status: "resolved",
    matchedVia: "comboName",
    kind: "combo",
    comboName: "o360-cheap-worker",
  });
});

test("tier 3 — exact target label, case-insensitive, when no synonym/combo-name matches", async () => {
  await updateSettings({ explicitTargetAliases: {} });
  const allCombos = [
    {
      name: "o360-coding",
      strategy: "priority",
      models: [{ id: "s1", model: "cx/gpt-5.6-sol-high", label: "Reviewer" }],
    },
  ];
  const result = await resolveExplicitTarget({
    alias: "reviewer",
    combo: allCombos[0],
    allCombos,
  });
  assert.deepEqual(result, {
    status: "resolved",
    matchedVia: "label",
    kind: "model",
    modelStr: "cx/gpt-5.6-sol-high",
  });
});

test("tier 3 ambiguity — the same label on two different targets fails closed", async () => {
  await updateSettings({ explicitTargetAliases: {} });
  const allCombos = [
    {
      name: "combo-a",
      strategy: "priority",
      models: [{ id: "s1", model: "cx/model-a", label: "Critic" }],
    },
    {
      name: "combo-b",
      strategy: "priority",
      models: [{ id: "s1", model: "cx/model-b", label: "Critic" }],
    },
  ];
  const result = await resolveExplicitTarget({
    alias: "critic",
    combo: allCombos[0],
    allCombos,
  });
  assert.equal(result.status, "ambiguous");
  assert.equal((result as { tier: string }).tier, "label");
});

test("tier 4 — literal model id validated via isModelAvailable", async () => {
  await updateSettings({ explicitTargetAliases: {} });
  const result = await resolveExplicitTarget({
    alias: "cx/gpt-5.6-sol-high",
    combo: currentCombo,
    allCombos: [currentCombo],
    isModelAvailable: async (modelStr: string) => modelStr === "cx/gpt-5.6-sol-high",
  });
  assert.deepEqual(result, {
    status: "resolved",
    matchedVia: "modelId",
    kind: "model",
    modelStr: "cx/gpt-5.6-sol-high",
  });
});

test("no tier matches → UNKNOWN_TARGET (unknown status), never a silent default", async () => {
  await updateSettings({ explicitTargetAliases: {} });
  const result = await resolveExplicitTarget({
    alias: "foo-model",
    combo: currentCombo,
    allCombos: [currentCombo],
    isModelAvailable: async () => false,
  });
  assert.deepEqual(result, { status: "unknown" });
});

test("precedence — a synonym match short-circuits before combo-name/label tiers are even consulted", async () => {
  // "o360-cheap-worker" is BOTH a real combo name AND overridden by a synonym
  // pointing somewhere else — the synonym (tier 1) must win.
  await updateSettings({
    explicitTargetAliases: { "o360-cheap-worker": "cx/gpt-5.6-sol-high" },
  });
  const allCombos = [currentCombo, { name: "o360-cheap-worker", models: ["zai/glm-5.1"] }];
  const result = await resolveExplicitTarget({
    alias: "o360-cheap-worker",
    combo: currentCombo,
    allCombos,
  });
  assert.deepEqual(result, {
    status: "resolved",
    matchedVia: "synonym",
    kind: "model",
    modelStr: "cx/gpt-5.6-sol-high",
  });
});
