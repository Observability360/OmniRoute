// O360 explicit-target-routing V1 — natural-language detector unit tests.
// The deterministic "/route <target>" command has its own test file:
// combo-route-slash-command.test.ts.
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
// Capitalization is NOT a routing signal — every one of these must extract
// identically whether the alias is typed uppercase or lowercase. Whether the
// candidate actually resolves to something real is the resolver's job
// (explicitTargetResolver.ts), and whether an unresolved candidate fails
// closed or falls through is tryExplicitTargetDispatch.ts's job — both out of
// scope for this module's own tests.

for (const phrase of [
  "use Astra para criticar isso",
  "pede pro Astra revisar",
  "pergunta pro Claude",
  "manda o Astra analisar",
  "manda Claude criticar isso",
  "manda claude criticar isso",
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

// ── lowercase aliases — capitalization must never gate extraction ────────────

for (const [phrase, alias] of [
  ["use astra", "astra"],
  ["usa claude", "claude"],
  ["pede pro astra revisar", "astra"],
  ["manda claude criticar isso", "claude"],
  ["com o astra, procure falhas", "astra"],
] as const) {
  test(`detectExplicitTargetPhrase: lowercase alias — "${phrase}" extracts "${alias}"`, () => {
    assert.deepEqual(detectExplicitTargetPhrase(phrase), { alias });
  });
}

// ── lowercase-hyphenated combo names and literal model ids (with `/`/`.`) ────
// Real targets are routinely NOT proper nouns: combo names are
// lowercase-hyphenated, and literal model ids (explicitTargetResolver.ts
// tier 4) carry `/` and `.`. Both must be extractable — whether they resolve
// is the resolver's concern, tested at dispatch level.

test('detectExplicitTargetPhrase: "use o360-cheap-worker" extracts the full lowercase-hyphenated combo name', () => {
  assert.deepEqual(detectExplicitTargetPhrase("use o360-cheap-worker"), {
    alias: "o360-cheap-worker",
  });
});

test('detectExplicitTargetPhrase: "use cx/gpt-5.6-sol-high" extracts the full literal model id including "/" and "."', () => {
  assert.deepEqual(detectExplicitTargetPhrase("use cx/gpt-5.6-sol-high"), {
    alias: "cx/gpt-5.6-sol-high",
  });
});

// ── detectExplicitTargetPhrase — required negative cases (no match at all) ───

test('detectExplicitTargetPhrase: bare mention "Astra" alone does not match', () => {
  assert.equal(detectExplicitTargetPhrase("Astra"), null);
});

test('detectExplicitTargetPhrase: "documentação diz para usar Astra" does not match (infinitive "usar", not a command)', () => {
  assert.equal(detectExplicitTargetPhrase("documentação diz para usar Astra"), null);
});

// ── ordinary sentences — extraction is fine; "must not trigger routing" is
// proven at the dispatch level (combo-explicit-target-dispatch.test.ts),
// because natural language is deliberately conservative: an unresolved
// candidate always falls through instead of failing closed. Capitalization
// must never be the gate here — "combo"/"tool" are exactly as valid a
// candidate shape as "Astra" is; what actually saves these from becoming
// UNKNOWN_TARGET 400s is that natural language NEVER fails closed on its
// own account (only "/route" does — see routeSlashCommand.ts).

for (const [phrase, alias] of [
  ["Use combo fallback", "combo"],
  ["Use combo fallback but force a throw", "combo"],
  ["Use a tool to look something up", "tool"],
  ["manda a mensagem", "mensagem"],
] as const) {
  test(`detectExplicitTargetPhrase: ordinary sentence — "${phrase}" extracts candidate "${alias}" (fallthrough proven at dispatch level)`, () => {
    assert.deepEqual(detectExplicitTargetPhrase(phrase), { alias });
  });
}

// ── "com o <alias>" — required false-positive fix ────────────────────────────

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
