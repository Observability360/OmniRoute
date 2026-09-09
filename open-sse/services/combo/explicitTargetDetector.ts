/**
 * Explicit target detector — natural-language "use <alias>" style commands in
 * the caller's own last turn (O360 explicit-target-routing V1).
 *
 * This is the CONVENIENCE path, not the deterministic control API — that is
 * routeSlashCommand.ts's "/route <target>" (checked first, higher priority,
 * by tryExplicitTargetDispatch.ts). Natural language is intentionally
 * conservative: it never fails a request closed on its own account. An
 * unresolved natural-language candidate simply falls through to ordinary
 * chat (see tryExplicitTargetDispatch.ts) — only an unresolved "/route"
 * command, or a candidate that resolves but is ambiguous/unavailable, fails
 * closed. This keeps the regex here small on purpose: it only has to decide
 * WHETHER the last user-role message asks to route to a named target, not
 * how confidently, and it never resolves the alias to a real model/combo
 * (see explicitTargetResolver.ts).
 *
 * Scope is intentionally narrow beyond that too: this module never looks at
 * anything but the last role="user" message — never system messages,
 * assistant history, tool results, or earlier user turns. Control text from
 * anywhere else in the conversation is not something the caller typed to
 * OmniRoute just now, and is not a safe place to look for a routing command.
 */

/** One content part in an OpenAI/Anthropic-shaped message.content array. */
type MessageContentPart = { type?: unknown; text?: unknown } | string;

type MessageLike = {
  role?: unknown;
  content?: string | MessageContentPart[] | unknown;
};

/**
 * Flatten an OpenAI/Anthropic-shaped content-parts array to plain text — only
 * "text"/"input_text" parts contribute — image and tool-shaped parts are
 * ignored, mirroring the part-type filter already used by
 * extractMessageContents() in src/shared/utils/inputSanitizer.ts. Split out of
 * extractLastUserMessageText() purely to keep that function's own branching
 * shallow; no behavior change.
 */
function extractTextFromContentParts(content: MessageContentPart[]): string | null {
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: unknown; text?: unknown };
    if ((p.type === "text" || p.type === "input_text") && typeof p.text === "string") {
      parts.push(p.text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Extract the plain text of the LAST role="user" message in the request body,
 * handling both a plain string `content` and an OpenAI/Anthropic-shaped
 * content-parts array (only "text"/"input_text" parts contribute — image and
 * tool-shaped parts are ignored, mirroring the part-type filter already used
 * by extractMessageContents() in src/shared/utils/inputSanitizer.ts).
 *
 * Returns null when there is no user message or its content is empty/unusable.
 *
 * Shared with routeSlashCommand.ts — the deterministic "/route" path scans
 * the same last-user-turn text, just with different (simpler) matching
 * rules.
 */
export function extractLastUserMessageText(body: Record<string, unknown>): string | null {
  const raw = body?.messages;
  const messages = Array.isArray(raw) ? raw : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as MessageLike;
    if (!msg || typeof msg !== "object" || msg.role !== "user") continue;
    const { content } = msg;
    if (typeof content === "string") {
      return content.length > 0 ? content : null;
    }
    if (Array.isArray(content)) {
      return extractTextFromContentParts(content);
    }
    return null;
  }
  return null;
}

// Reuse the same literal markers flattenToolHistory.ts already uses to embed
// tool calls/results into plain text for providers with no native tool
// messages — recognizing them here means a message that went through that
// flattening doesn't get re-scanned as if it were the user's own words.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

const FENCED_CODE_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE_SPAN = /`[^`\n]*`/g;

/**
 * Strip fenced code blocks, inline code spans, and recognizable flattened
 * tool-call/tool-result segments from a block of text, leaving only the
 * natural-language remainder to run explicit-command patterns against.
 *
 * Deliberately does not attempt to recognize arbitrary/unfenced tool payloads
 * pasted as plain prose — that is not a solvable text-shape problem without a
 * real parser, and is out of scope for V1 (see the patch's OPEN_ISSUES).
 */
export function stripControlNoise(text: string): string {
  let out = text.replace(FENCED_CODE_BLOCK, " ").replace(INLINE_CODE_SPAN, " ");
  out = out
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith(TOOL_CALL_PREFIX) && !trimmed.startsWith(TOOL_RESULT_PREFIX);
    })
    .join("\n");
  return out;
}

export type ExplicitTargetMatch = { alias: string };

/**
 * Command verbs that introduce an explicit-target phrase. "usar" (infinitive)
 * is deliberately EXCLUDED: in Portuguese it is the form used in
 * reported/descriptive speech ("para usar Astra", "recomendo usar o Claude")
 * — not a direct command. The imperative forms "use"/"usa" (2nd person) are
 * what a real command uses ("use Astra", "usa o Claude"), so only those are
 * treated as command verbs. This is the concrete fix for the required
 * negative case: "documentação diz para usar Astra" must never match.
 *
 * First-letter character classes (not the `i` flag) cover sentence-initial
 * capitalization ("Use Astra") — see CANDIDATE below for why `i` is avoided
 * entirely in this file.
 */
const COMMAND_VERBS = "(?:[Uu]se|[Uu]sa|[Pp]ede|[Pp]eça|[Pp]ergunta|[Pp]ergunte|[Mm]anda|[Mm]ande)";

/**
 * Optional Portuguese connector between the verb and the candidate ("pede
 * PRO Astra", "manda O Claude").
 */
const CONNECTOR = "(?:pro|pra|para|ao|à|o|a)";

/**
 * The candidate token itself. Aliases, combo names, and literal model ids
 * are NOT proper nouns as a matter of system design — "Astra"/"Claude" are
 * just examples, real combo names are routinely lowercase-hyphenated
 * ("o360-cheap-worker") and literal model ids carry `/` and `.`
 * ("cx/gpt-5.6-sol-high", per explicitTargetResolver.ts's own tier-4
 * literal-model-id lookup). Capitalization must never gate whether a
 * candidate is even extracted — only whether it turns out to resolve to
 * something real (see explicitTargetResolver.ts) decides that. No `i` flag
 * is used anywhere in this file's patterns: combined with `u`, `i` case-folds
 * Unicode property escapes like `\p{Lu}` in V8/JS (confirmed empirically,
 * moot here since this class no longer needs `\p{Lu}`, but avoided
 * throughout so that trap is never reintroduced later).
 */
const CANDIDATE = "([\\p{L}][\\p{L}0-9_\\-./]{1,79})";

const VERB_FIRST_PATTERN = new RegExp(
  `\\b${COMMAND_VERBS}\\b(?:\\s+${CONNECTOR}\\b)?\\s+${CANDIDATE}`,
  "u"
);

/**
 * "com o/a <alias>" alone is NOT enough signal: it matches plain descriptive/
 * reported-speech sentences just as easily as a command —
 * "ontem falei com o Astra sobre isso", "já conversei com o Astra",
 * "isso foi revisado com o Astra" all contain the exact same "com o <alias>"
 * shape with zero routing intent. The one required-positive example,
 * "com o Astra, procure falhas", has a real structural signal the negatives
 * don't: an imperative task verb immediately follows the alias (across an
 * optional comma). Requiring that verb (via a lookahead, so it isn't
 * consumed/captured) is what separates a real command from a mention.
 */
const TASK_IMPERATIVE_VERBS =
  "procure|verifique|analise|revise|critique|corrija|avalie|teste|confirme|valide|" +
  "aponte|liste|resuma|explique|mostre|diga|ache|encontre|chame|pergunte|pe[çc]a|" +
  "execute|rode|gere|crie|escreva|refatore|otimize";

const COM_O_PATTERN = new RegExp(
  `\\b[Cc]om\\s+(?:o|a)\\s+${CANDIDATE}\\s*,?\\s*(?=\\b(?:${TASK_IMPERATIVE_VERBS})\\b)`,
  "u"
);

/**
 * Detect an explicit-target command in already-sanitized natural-language
 * text (see stripControlNoise). Returns the raw alias token as typed, or
 * null when no command pattern matches — a bare mention of an alias name
 * with no leading command verb ("Astra", "a documentação fala do Astra")
 * never matches, by construction.
 */
export function detectExplicitTargetPhrase(sanitizedText: string): ExplicitTargetMatch | null {
  const verbMatch = VERB_FIRST_PATTERN.exec(sanitizedText);
  if (verbMatch?.[1]) return { alias: verbMatch[1] };

  const comMatch = COM_O_PATTERN.exec(sanitizedText);
  if (comMatch?.[1]) return { alias: comMatch[1] };

  return null;
}

/**
 * Full pipeline: last user message → strip code/tool noise → detect command.
 * tryExplicitTargetDispatch.ts calls this only after routeSlashCommand.ts's
 * deterministic "/route" check has already come up empty.
 */
export function detectExplicitTargetInBody(
  body: Record<string, unknown>
): ExplicitTargetMatch | null {
  const text = extractLastUserMessageText(body);
  if (!text) return null;
  const sanitized = stripControlNoise(text);
  return detectExplicitTargetPhrase(sanitized);
}
