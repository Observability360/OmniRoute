// O360 explicit-target-routing V1 — detector unit tests.
import test from "node:test";
import assert from "node:assert/strict";

import {
  detectExplicitTargetInBody,
  detectExplicitTargetPhrase,
  extractLastUserMessageText,
  stripControlNoise,
} from "../../../open-sse/services/combo/explicitTargetDetector.ts";

function bodyWithUser(text: string, extraMessages: Record<string, unknown>[] = []) {
  return { messages: [...extraMessages, { role: "user", content: text }] };
}

// ── extractLastUserMessageText ───────────────────────────────────────────────

test("extractLastUserMessageText: plain string content", () => {
  assert.equal(extractLastUserMessageText(bodyWithUser("use Astra")), "use Astra");
});

test("extractLastUserMessageText: content-parts array, text parts only", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "use Astra" },
          { type: "image_url", image_url: { url: "data:..." } },
          { type: "input_text", text: "para revisar" },
        ],
      },
    ],
  };
  assert.equal(extractLastUserMessageText(body), "use Astra\npara revisar");
});

test("extractLastUserMessageText: only the LAST user message counts, not assistant/system/earlier user turns", () => {
  const body = {
    messages: [
      { role: "system", content: "use Astra" },
      { role: "user", content: "primeiro turno, ignorar" },
      { role: "assistant", content: "use Astra (assistant said this, must not count)" },
      { role: "user", content: "agora use Astra para criticar" },
    ],
  };
  assert.equal(extractLastUserMessageText(body), "agora use Astra para criticar");
});

test("extractLastUserMessageText: no user message returns null", () => {
  assert.equal(extractLastUserMessageText({ messages: [{ role: "system", content: "x" }] }), null);
});

// ── stripControlNoise ─────────────────────────────────────────────────────────

test("stripControlNoise: removes fenced code blocks but keeps surrounding prose", () => {
  const text = "use Astra para revisar:\n```python\nuse_astra = True\n```\nobrigado";
  const out = stripControlNoise(text);
  assert.ok(!out.includes("use_astra"));
  assert.ok(out.includes("use Astra para revisar"));
});

test("stripControlNoise: removes inline code spans", () => {
  const out = stripControlNoise("veja a variável `use_astra_flag` e use Astra para revisar");
  assert.ok(!out.includes("use_astra_flag"));
  assert.ok(out.includes("use Astra para revisar"));
});

test("stripControlNoise: drops flattened tool-call/tool-result lines", () => {
  const text = [
    "use Astra para revisar",
    '[Called tools: grep(pattern="use Astra")]',
    "[Tool result: use Astra found in 3 files]",
  ].join("\n");
  const out = stripControlNoise(text);
  assert.ok(out.includes("use Astra para revisar"));
  assert.ok(!out.includes("Called tools"));
  assert.ok(!out.includes("Tool result"));
});

// ── detectExplicitTargetPhrase — positive cases ───────────────────────────────

for (const phrase of [
  "use Astra para criticar isso",
  "pede pro Astra revisar",
  "pergunta pro Claude",
  "manda o Astra analisar",
  "com o Astra, procure falhas",
]) {
  test(`detectExplicitTargetPhrase: positive — "${phrase}"`, () => {
    const result = detectExplicitTargetPhrase(phrase);
    assert.ok(result, `expected a match for: ${phrase}`);
  });
}

test('detectExplicitTargetPhrase: "use Astra para criticar isso" extracts alias "Astra"', () => {
  assert.deepEqual(detectExplicitTargetPhrase("use Astra para criticar isso"), { alias: "Astra" });
});

test('detectExplicitTargetPhrase: "manda o Astra analisar" extracts alias "Astra" (article swallowed)', () => {
  assert.deepEqual(detectExplicitTargetPhrase("manda o Astra analisar"), { alias: "Astra" });
});

test('detectExplicitTargetPhrase: "com o Astra, procure falhas" extracts alias "Astra"', () => {
  assert.deepEqual(detectExplicitTargetPhrase("com o Astra, procure falhas"), { alias: "Astra" });
});

// ── detectExplicitTargetPhrase — required negative cases ─────────────────────

test('detectExplicitTargetPhrase: bare mention "Astra" alone does not match', () => {
  assert.equal(detectExplicitTargetPhrase("Astra"), null);
});

test('detectExplicitTargetPhrase: "documentação diz para usar Astra" does not match (infinitive "usar", not a command)', () => {
  assert.equal(detectExplicitTargetPhrase("documentação diz para usar Astra"), null);
});

// ── "com o <alias>" — required false-positive fix ────────────────────────────
// "com o <alias>" alone (no imperative task verb immediately following) is
// descriptive/reported speech, not a command, and must never trigger routing.

for (const phrase of [
  "ontem falei com o Astra sobre isso",
  "já conversei com o Astra",
  "isso foi revisado com o Astra",
  "com o Astra tudo certo",
]) {
  test(`detectExplicitTargetPhrase: "com o" false-positive — "${phrase}" does not match`, () => {
    assert.equal(detectExplicitTargetPhrase(phrase), null);
  });
}

test('detectExplicitTargetPhrase: "com o Astra, procure falhas" still matches (imperative verb present)', () => {
  assert.deepEqual(detectExplicitTargetPhrase("com o Astra, procure falhas"), { alias: "Astra" });
});

for (const phrase of [
  "com o Astra critique o código",
  "com o Claude, corrija os testes",
  "com a Astra verifique isso",
]) {
  test(`detectExplicitTargetPhrase: "com o" + imperative verb — positive — "${phrase}"`, () => {
    const result = detectExplicitTargetPhrase(phrase);
    assert.ok(result, `expected a match for: ${phrase}`);
  });
}

test('detectExplicitTargetPhrase: "a documentação recomenda usar o Claude" does not match', () => {
  assert.equal(detectExplicitTargetPhrase("a documentação recomenda usar o Claude"), null);
});

// ── full pipeline: natural command + fenced code in the SAME message ─────────

test("detectExplicitTargetInBody: a real command survives even with a fenced code block in the same message", () => {
  const body = bodyWithUser(
    'use Astra para revisar:\n```python\ndef f():\n    return "use Astra"\n```'
  );
  assert.deepEqual(detectExplicitTargetInBody(body), { alias: "Astra" });
});

test("detectExplicitTargetInBody: code-only content (fenced) with no natural command does not match", () => {
  const body = bodyWithUser('```python\n# use Astra\nprint("use Astra")\n```');
  assert.equal(detectExplicitTargetInBody(body), null);
});

test("detectExplicitTargetInBody: no explicit-target body returns null", () => {
  assert.equal(detectExplicitTargetInBody(bodyWithUser("corrija os pontos que encontrou")), null);
});
