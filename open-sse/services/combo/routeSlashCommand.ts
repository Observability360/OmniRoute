/**
 * Deterministic "/route <target>" slash command — O360 explicit-target-
 * routing V1 hybrid contract. Highest routing priority: checked before the
 * natural-language detector (explicitTargetDetector.ts) by
 * tryExplicitTargetDispatch.ts. Unlike natural language, an unresolved
 * "/route" target ALWAYS fails closed — the syntax itself is deterministic
 * and unambiguous, so there is no "was this really meant as a command?"
 * question left to hedge on.
 *
 * Recognized ONLY as the first non-blank line of the last role="user"
 * message's plain text (see extractLastUserMessageText — shared with the
 * natural-language detector, so this also never looks at system/assistant
 * messages or earlier user turns). Deliberately does NOT reuse
 * stripControlNoise's fenced/inline-code stripping: a real "/route" command
 * is never itself wrapped in a code fence or inline-code span in any of the
 * required examples, and — more importantly — a fence/span's own opening
 * marker (an entire "```" line, or a leading backtick) already occupies the
 * first-line position instead of "/route", so a plain first-line check
 * already satisfies "must not be recognized inside fenced/inline code"
 * without needing to touch (and risk mangling) the rest of the message.
 */
import { extractLastUserMessageText } from "./explicitTargetDetector.ts";

export type RouteSlashCommandMatch = {
  /** The raw target token/string as typed, trimmed. Never case-normalized
   *  or otherwise interpreted here — resolution is explicitTargetResolver.ts's
   *  job. */
  target: string;
  /** The last user message's text with the "/route <target>" line removed,
   *  trimmed. Empty when the command was the ONLY content of the turn — the
   *  caller (tryExplicitTargetDispatch.ts) fails that closed with
   *  MISSING_TASK rather than forwarding an empty prompt. */
  strippedTaskContent: string;
};

const ROUTE_LINE_PATTERN = /^[ \t]*\/route[ \t]+(\S+)(?:[ \t]+(.*?))?[ \t]*$/u;

function firstNonBlankLineIndex(lines: string[]): number {
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  return i;
}

/**
 * Detect a "/route <target>" directive in already-extracted plain text (see
 * extractLastUserMessageText). The target is the first token after `/route`.
 * Remaining text on that line, plus all following lines, is task content.
 * Targets are aliases, combo names, or model ids and cannot contain spaces.
 */
export function detectRouteSlashCommandInText(text: string): RouteSlashCommandMatch | null {
  const lines = text.split(/\r?\n/);
  const idx = firstNonBlankLineIndex(lines);
  if (idx >= lines.length) return null;

  const match = ROUTE_LINE_PATTERN.exec(lines[idx]);
  if (!match?.[1]) return null;

  const target = match[1].trim();
  if (!target) return null;

  const sameLineTask = match[2]?.trim();
  const remainingLines = [
    ...lines.slice(0, idx),
    ...(sameLineTask ? [sameLineTask] : []),
    ...lines.slice(idx + 1),
  ];
  const strippedTaskContent = remainingLines.join("\n").trim();

  return { target, strippedTaskContent };
}

/**
 * Full pipeline: last user message → detect "/route" directive. The single
 * entry point tryExplicitTargetDispatch.ts should call, before falling back
 * to the natural-language detector.
 */
export function detectRouteSlashCommandInBody(
  body: Record<string, unknown>
): RouteSlashCommandMatch | null {
  const text = extractLastUserMessageText(body);
  if (!text) return null;
  return detectRouteSlashCommandInText(text);
}
