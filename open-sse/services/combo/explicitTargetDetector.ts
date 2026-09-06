/**
 * Explicit target detector — natural-language "use <alias>" style commands in
 * the caller's own last turn (O360 explicit-target-routing V1).
 *
 * Scope is intentionally narrow: this module only decides WHETHER the last
 * user-role message asks to route to a named target, and extracts the alias
 * text. It never resolves the alias to a real model/combo (see
 * explicitTargetResolver.ts) and never looks at anything but the last
 * role="user" message — never system messages, assistant history, tool
 * results, or earlier user turns. That scope limit is deliberate: control text
 * from anywhere else in the conversation is not something the caller typed to
 * OmniRoute just now, and is not a safe place to look for a routing command.
 */

/** One content part in an OpenAI/Anthropic-shaped message.content array. */
type MessageContentPart = { type?: unknown; text?: unknown } | string;

type MessageLike = {
  role?: unknown;
  content?: string | MessageContentPart[] | unknown;
};

/**
 * Extract the plain text of the LAST role="user" message in the request body,
 * handling both a plain string `content` and an OpenAI/Anthropic-shaped
 * content-parts array (only "text"/"input_text" parts contribute — image and
 * tool-shaped parts are ignored, mirroring the part-type filter already used
 * by extractMessageContents() in src/shared/utils/inputSanitizer.ts).
 *
 * Returns null when there is no user message or its content is empty/unusable.
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

/**
 * High-precision explicit-target command patterns.
 *
 * "usar" (infinitive) is deliberately EXCLUDED from the verb set: in Portuguese
 * it is the form used in reported/descriptive speech ("para usar Astra",
 * "recomendo usar o Claude") — not a direct command. The imperative forms
 * "use"/"usa" (2nd person) are what a real command uses ("use Astra",
 * "usa o Claude"), so only those are treated as command verbs. This is the
 * concrete fix for the required negative case: "documentação diz para usar
 * Astra" must never match.
 */
const VERB_FIRST_PATTERN =
  /\b(?:use|usa|pede|peça|pergunta|pergunte|manda|mande)\b(?:\s+(?:pro|pra|para|ao|à|o|a)\b)?\s+([\p{L}][\p{L}0-9_-]{1,39})/iu;

const COM_O_PATTERN = /\bcom\s+(?:o|a)\s+([\p{L}][\p{L}0-9_-]{1,39})\b/iu;

/**
 * Detect an explicit-target command in already-sanitized natural-language
 * text (see stripControlNoise). Returns the raw alias token as typed, or null
 * when no command pattern matches — a bare mention of an alias name with no
 * leading command verb ("Astra", "a documentação fala do Astra") never
 * matches, by construction.
 */
export function detectExplicitTargetPhrase(sanitizedText: string): { alias: string } | null {
  const verbMatch = VERB_FIRST_PATTERN.exec(sanitizedText);
  if (verbMatch?.[1]) return { alias: verbMatch[1] };
  const comMatch = COM_O_PATTERN.exec(sanitizedText);
  if (comMatch?.[1]) return { alias: comMatch[1] };
  return null;
}

/**
 * Full pipeline: last user message → strip code/tool noise → detect command.
 * The single entry point tryExplicitTargetDispatch.ts should call.
 */
export function detectExplicitTargetInBody(
  body: Record<string, unknown>
): { alias: string } | null {
  const text = extractLastUserMessageText(body);
  if (!text) return null;
  const sanitized = stripControlNoise(text);
  return detectExplicitTargetPhrase(sanitized);
}
