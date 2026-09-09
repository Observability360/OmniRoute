/**
 * Explicit target alias resolution — O360 explicit-target-routing V1.
 *
 * Resolves a human-typed alias ("Astra", "cheap-worker", ...) to a LOGICAL
 * destination — a combo name or a bare model/provider string — never directly
 * to a connection_id. The destination is handed back to OmniRoute's normal
 * dispatch (handleSingleModelWithTimeout for a model, handleComboChat for a
 * combo), which keeps choosing a healthy connection/account exactly as it
 * would for any other request. A future "pin one specific account" feature is
 * out of scope for V1 and would be a connection_id-based extension of this
 * same resolver, not a change to its precedence rules.
 *
 * Precedence (first tier with any match wins; a tier with more than one match
 * is ambiguous and fails closed — never first-match/last-match/silent order):
 *   1. explicit synonym (operator setting first, then built-in O360 friendly aliases)
 *   2. exact combo name
 *   3. exact ResolvedComboTarget/ResolvedComboRefTarget label (combo config)
 *   4. exact provider/model id (validated via the caller's isModelAvailable)
 *   5. UNKNOWN_TARGET
 *
 * Tiers 1-3 match the human-typed alias case-insensitively (that's the point
 * of a human alias). Tier 4 is a literal model-id lookup and is intentionally
 * case-sensitive, since model ids are case-sensitive tokens elsewhere in this
 * codebase (e.g. "cx/gpt-5.6-sol-high") — a human is not expected to reach
 * tier 4 by typing a bare alias; it exists for a power-user request that
 * already names a real model id.
 */
import { getSettings } from "../../../src/lib/db/settings.ts";
import { clampComboDepth } from "./comboPredicates.ts";
import { getCombosArray, resolveComboTargets } from "./comboStructure.ts";
import type {
  ComboCollectionLike,
  ComboLike,
  HiddenModelsByProvider,
  IsModelAvailable,
} from "./types.ts";

export type ExplicitTargetDestination =
  { kind: "model"; modelStr: string } | { kind: "combo"; comboName: string };

export type ExplicitTargetResolution =
  | ({
      status: "resolved";
      matchedVia: "synonym" | "comboName" | "label" | "modelId";
    } & ExplicitTargetDestination)
  | { status: "unknown" }
  | { status: "ambiguous"; tier: "synonym" | "comboName" | "label"; candidates: string[] };

/** Stable O360 V1 aliases. They keep the approved command surface working on
 *  a fresh deployment without requiring a settings write or schema change.
 *  An operator-provided synonym with the same key still wins. */
const DEFAULT_EXPLICIT_TARGET_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  astra: "cx/gpt-5.6-sol-high",
  claude: "cc/claude-sonnet-5",
});

/** "combo/<name>" ⇄ bare model string — the same convention already used for
 *  a combo request's own `model` field elsewhere in OmniRoute. Reusing it here
 *  means the synonym map and label lookups need no new {kind, value} shape. */
function parseDestinationString(value: string): ExplicitTargetDestination | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  if (trimmed.startsWith("combo/")) {
    const comboName = trimmed.slice("combo/".length).trim();
    return comboName ? { kind: "combo", comboName } : null;
  }
  return { kind: "model", modelStr: trimmed };
}

function destinationKey(d: ExplicitTargetDestination): string {
  return d.kind === "combo" ? `combo/${d.comboName}` : d.modelStr;
}

/** Dedupe candidates that resolve to the exact same destination before an
 *  ambiguity check, so two routes to the SAME place are never flagged as
 *  ambiguous — only genuinely different destinations are. */
function dedupeDestinations(items: ExplicitTargetDestination[]): ExplicitTargetDestination[] {
  const seen = new Map<string, ExplicitTargetDestination>();
  for (const item of items) {
    seen.set(destinationKey(item), item);
  }
  return [...seen.values()];
}

function resolveConfiguredSynonyms(alias: string, map: unknown): ExplicitTargetDestination[] {
  if (!map || typeof map !== "object") return [];
  const lowerAlias = alias.toLowerCase();
  const matches: ExplicitTargetDestination[] = [];
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (typeof key !== "string" || key.toLowerCase() !== lowerAlias) continue;
    if (typeof value !== "string") continue;
    const dest = parseDestinationString(value);
    if (dest) matches.push(dest);
  }
  return dedupeDestinations(matches);
}

async function resolveSynonymTier(alias: string): Promise<ExplicitTargetDestination[]> {
  const settings = await getSettings();
  const configuredMatches = resolveConfiguredSynonyms(alias, settings?.explicitTargetAliases);
  if (configuredMatches.length > 0) return configuredMatches;

  const defaultDestination = DEFAULT_EXPLICIT_TARGET_ALIASES[alias.toLowerCase()];
  const parsedDefault = defaultDestination ? parseDestinationString(defaultDestination) : null;
  return parsedDefault ? [parsedDefault] : [];
}

function resolveComboNameTier(
  alias: string,
  allCombos: ComboCollectionLike
): ExplicitTargetDestination[] {
  const lowerAlias = alias.toLowerCase();
  const combos = getCombosArray(allCombos);
  const matches = combos.filter((c) => c.name.toLowerCase() === lowerAlias);
  return dedupeDestinations(matches.map((c) => ({ kind: "combo" as const, comboName: c.name })));
}

/**
 * resolveComboTargets() flattens combo-ref steps into the referenced combo's
 * own model targets (see resolveNestedComboTargets) — it never returns a
 * ResolvedComboRefTarget, so every element here is a real model target with
 * its own label. A label set on the combo-ref STEP itself (rather than on a
 * model target inside the referenced combo) is not reachable through this
 * tier as a result — see OPEN_ISSUES in the patch notes. That is the one
 * known gap in an otherwise complete reuse of the existing resolution code.
 */
function resolveLabelTier(
  alias: string,
  allCombos: ComboCollectionLike,
  maxComboDepth: number,
  hiddenModelsByProvider: HiddenModelsByProvider | undefined
): ExplicitTargetDestination[] {
  const lowerAlias = alias.toLowerCase();
  const combos = getCombosArray(allCombos);
  const matches: ExplicitTargetDestination[] = [];
  for (const combo of combos) {
    const targets = resolveComboTargets(combo, allCombos, maxComboDepth, hiddenModelsByProvider);
    for (const target of targets) {
      const label = typeof target.label === "string" ? target.label.trim() : "";
      if (!label || label.toLowerCase() !== lowerAlias) continue;
      matches.push({ kind: "model", modelStr: target.modelStr });
    }
  }
  return dedupeDestinations(matches);
}

/**
 * Resolve a human-typed alias against the full precedence chain. Never falls
 * back to a default combo/model — an empty or ambiguous tier either advances
 * to the next tier (empty) or fails closed immediately (ambiguous).
 */
export async function resolveExplicitTarget(args: {
  alias: string;
  combo: ComboLike;
  allCombos: ComboCollectionLike;
  isModelAvailable?: IsModelAvailable;
  maxComboDepth?: unknown;
  hiddenModelsByProvider?: HiddenModelsByProvider;
}): Promise<ExplicitTargetResolution> {
  const { alias, allCombos, isModelAvailable, hiddenModelsByProvider } = args;
  const maxComboDepth = clampComboDepth(args.maxComboDepth);

  const synonymMatches = await resolveSynonymTier(alias);
  if (synonymMatches.length > 1) {
    return { status: "ambiguous", tier: "synonym", candidates: synonymMatches.map(destinationKey) };
  }
  if (synonymMatches.length === 1) {
    return { status: "resolved", matchedVia: "synonym", ...synonymMatches[0] };
  }

  const comboNameMatches = resolveComboNameTier(alias, allCombos);
  if (comboNameMatches.length > 1) {
    return {
      status: "ambiguous",
      tier: "comboName",
      candidates: comboNameMatches.map(destinationKey),
    };
  }
  if (comboNameMatches.length === 1) {
    return { status: "resolved", matchedVia: "comboName", ...comboNameMatches[0] };
  }

  const labelMatches = resolveLabelTier(alias, allCombos, maxComboDepth, hiddenModelsByProvider);
  if (labelMatches.length > 1) {
    return { status: "ambiguous", tier: "label", candidates: labelMatches.map(destinationKey) };
  }
  if (labelMatches.length === 1) {
    return { status: "resolved", matchedVia: "label", ...labelMatches[0] };
  }

  if (isModelAvailable) {
    try {
      const available = await isModelAvailable(alias);
      if (available) {
        return { status: "resolved", matchedVia: "modelId", kind: "model", modelStr: alias };
      }
    } catch {
      // Fail through to UNKNOWN_TARGET — a broken availability check must
      // never be treated as a match.
    }
  }

  return { status: "unknown" };
}
