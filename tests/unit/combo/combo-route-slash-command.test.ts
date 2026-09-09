// O360 explicit-target-routing V1 — deterministic "/route <target>" slash
// command detector unit tests. Natural language has its own test file:
// combo-explicit-target-detector.test.ts.
import test from "node:test";
import assert from "node:assert/strict";

import {
  detectRouteSlashCommandInBody,
  detectRouteSlashCommandInText,
} from "../../../open-sse/services/combo/routeSlashCommand.ts";

function bodyWithUser(text: string, extraMessages: Record<string, unknown>[] = []) {
  return { messages: [...extraMessages, { role: "user", content: text }] };
}

// ── positive cases — case must never matter for the target token ────────────

for (const target of ["claude", "Claude", "CLAUDE", "astra", "o360-coding", "o360-cheap-worker"]) {
  test(`detectRouteSlashCommandInText: "/route ${target}" extracts target "${target}" with no task`, () => {
    assert.deepEqual(detectRouteSlashCommandInText(`/route ${target}`), {
      target,
      strippedTaskContent: "",
    });
  });
}

test('detectRouteSlashCommandInText: "/route cx/gpt-5.6-sol-high" extracts the full literal model id including "/" and "."', () => {
  assert.deepEqual(detectRouteSlashCommandInText("/route cx/gpt-5.6-sol-high"), {
    target: "cx/gpt-5.6-sol-high",
    strippedTaskContent: "",
  });
});

test('detectRouteSlashCommandInText: "/route TotallyUnknown" extracts the target regardless of whether it resolves (resolution is the resolver\'s job)', () => {
  assert.deepEqual(detectRouteSlashCommandInText("/route TotallyUnknown"), {
    target: "TotallyUnknown",
    strippedTaskContent: "",
  });
});

// ── task content on following line(s) is stripped from the control line
// only — the actual task text must survive completely, formatting and all.

test("detectRouteSlashCommandInText: task text on the following line is preserved as strippedTaskContent", () => {
  const result = detectRouteSlashCommandInText(
    "/route claude\nReview this implementation for race conditions."
  );
  assert.deepEqual(result, {
    target: "claude",
    strippedTaskContent: "Review this implementation for race conditions.",
  });
});

test("detectRouteSlashCommandInText: task text on the directive line is preserved", () => {
  assert.deepEqual(detectRouteSlashCommandInText("/route claude Explain this code"), {
    target: "claude",
    strippedTaskContent: "Explain this code",
  });
});

test("detectRouteSlashCommandInText: same-line and following-line task text are both preserved", () => {
  assert.deepEqual(detectRouteSlashCommandInText("/route astra Review this\nand explain why"), {
    target: "astra",
    strippedTaskContent: "Review this\nand explain why",
  });
});

test("detectRouteSlashCommandInText: multi-line task content (including blank lines) survives intact", () => {
  const result = detectRouteSlashCommandInText(
    "/route claude\n\nReview this.\n\nMore context below."
  );
  assert.deepEqual(result, {
    target: "claude",
    strippedTaskContent: "Review this.\n\nMore context below.",
  });
});

test("detectRouteSlashCommandInText: a fenced code block AFTER the command in real task text is preserved untouched", () => {
  const result = detectRouteSlashCommandInText(
    "/route claude\nReview this:\n```js\nfunction foo() { return 1; }\n```"
  );
  assert.deepEqual(result, {
    target: "claude",
    strippedTaskContent: "Review this:\n```js\nfunction foo() { return 1; }\n```",
  });
});

// ── missing task — the command was the ONLY content of the turn ─────────────

test('detectRouteSlashCommandInText: "/route claude" alone has empty strippedTaskContent', () => {
  const result = detectRouteSlashCommandInText("/route claude");
  assert.equal(result?.strippedTaskContent, "");
});

// ── must NOT be recognized inside fenced code, inline code, or if not the
// first line ──────────────────────────────────────────────────────────────

test("detectRouteSlashCommandInText: /route wrapped in a fenced code block does not route", () => {
  assert.equal(detectRouteSlashCommandInText("```\n/route claude\n```"), null);
});

test("detectRouteSlashCommandInText: /route wrapped in inline code does not route", () => {
  assert.equal(detectRouteSlashCommandInText("`/route claude`"), null);
});

test("detectRouteSlashCommandInText: /route not on the first non-blank line does not route", () => {
  assert.equal(detectRouteSlashCommandInText("some preamble text\n/route claude"), null);
});

test("detectRouteSlashCommandInText: leading blank lines before the command are tolerated", () => {
  assert.deepEqual(detectRouteSlashCommandInText("\n\n/route claude\ntask"), {
    target: "claude",
    strippedTaskContent: "task",
  });
});

// ── malformed / absent command ────────────────────────────────────────────

test("detectRouteSlashCommandInText: ordinary prose without a slash command does not match", () => {
  assert.equal(detectRouteSlashCommandInText("use Astra para revisar"), null);
});

test('detectRouteSlashCommandInText: "/routeclaude" (no space) does not match', () => {
  assert.equal(detectRouteSlashCommandInText("/routeclaude"), null);
});

test('detectRouteSlashCommandInText: "/route" with no target at all does not match', () => {
  assert.equal(detectRouteSlashCommandInText("/route"), null);
});

test('detectRouteSlashCommandInText: "/route" followed by only whitespace does not match', () => {
  assert.equal(detectRouteSlashCommandInText("/route   "), null);
});

// ── full pipeline: only the LAST user message counts ────────────────────────

test("detectRouteSlashCommandInBody: only the last role=user message is scanned, not assistant/system/earlier turns", () => {
  const body = {
    messages: [
      { role: "system", content: "/route claude" },
      { role: "user", content: "primeiro turno" },
      { role: "assistant", content: "/route claude (assistant said this, must not count)" },
      { role: "user", content: "/route astra\nreview this" },
    ],
  };
  assert.deepEqual(detectRouteSlashCommandInBody(body), {
    target: "astra",
    strippedTaskContent: "review this",
  });
});

test("detectRouteSlashCommandInBody: no slash command in the last user message returns null", () => {
  assert.equal(detectRouteSlashCommandInBody(bodyWithUser("just a normal message")), null);
});

test("detectRouteSlashCommandInBody: content-parts array input is scanned the same way", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "/route claude" },
          { type: "input_text", text: "review this" },
        ],
      },
    ],
  };
  assert.deepEqual(detectRouteSlashCommandInBody(body), {
    target: "claude",
    strippedTaskContent: "review this",
  });
});
