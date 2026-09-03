import type { SpaceSummary } from "../../types";
import type { ClassificationConfidence } from "../../types";
import { SPACE_TYPES, tryGetSpaceType, type SpaceTypeEntry } from "./space-types";

export type SpaceClassification = {
  spaceGlobalId: string;
  spaceTypeKey: string;
  confidence: ClassificationConfidence;
};

/**
 * Common IFC/architectural name fragments → ASHRAE 62.1 space-type key.
 * Keep this list small and unambiguous: anything subtle goes to the LLM.
 * Order matters — first match wins.
 */
const ALIAS_RULES: { pattern: RegExp; spaceTypeKey: string }[] = [
  { pattern: /\bconference\b|\bmeeting\b/i, spaceTypeKey: "conference-meeting" },
  { pattern: /\bcorridor\b|\bhallway\b/i, spaceTypeKey: "corridors" },
  { pattern: /\blobby\b|\blobbies\b|\bvestibule\b/i, spaceTypeKey: "main-entry-lobbies" },
  {
    pattern:
      /\brestroom\b|\btoilet\b|\bwc\b|\bwashroom\b|\bbathroom\b|\bmen\b|\bmens\b|\bwomen\b|\bwomens\b|\bfamily\s+rr\b|\bunisex\b/i,
    spaceTypeKey: "toilets-public-light"
  },
  { pattern: /\bqueu(?:e|ing)\b|\bwaiting\b/i, spaceTypeKey: "transportation-waiting" },
  { pattern: /\bcounter\s+area\b|\bservice\s+counter\b|\bteller\b/i, spaceTypeKey: "sales" },
  { pattern: /\bboh\b|\bback[-\s]of[-\s]house\b/i, spaceTypeKey: "offices-commercial-general" },
  { pattern: /\bstorage\b|\bstore ?room\b|\butility\s+yard\b/i, spaceTypeKey: "occupiable-storage-for-dry-materials" },
  { pattern: /\bjanitor\b|\bjan\b|\bcustodian\b|\btrash\b/i, spaceTypeKey: "janitor-trash-recycle" },
  { pattern: /\bidf\b|\bmdf\b|\btelecom\b|\bdata\s+closet\b|\bserver\s+room\b/i, spaceTypeKey: "idf-mdf-electronic-eqpt" },
  { pattern: /\belectrical\b|\belec(?:trical)?\s*room\b/i, spaceTypeKey: "electrical-equipment-rooms" },
  { pattern: /\bmechanical\b|\bmech\s+room\b/i, spaceTypeKey: "electrical-equipment-rooms" },
  { pattern: /\bclassroom\b|\bclass ?room\b/i, spaceTypeKey: "classrooms-ages-9-and-up" },
  { pattern: /\bkitchen\b/i, spaceTypeKey: "kitchens-cooking" },
  { pattern: /\bkitchenette\b/i, spaceTypeKey: "kitchenettes" },
  { pattern: /\bbreak\s*room\b|\bbreakroom\b/i, spaceTypeKey: "breakrooms" },
  { pattern: /\boffice\b/i, spaceTypeKey: "offices-commercial-general" }
];

/** Alias rules are validated against the loaded space-type table so broken
 *  keys become loud errors at startup, not at classification time. */
for (const rule of ALIAS_RULES) {
  if (!tryGetSpaceType(rule.spaceTypeKey)) {
    throw new Error(
      `ALIAS_RULES references unknown space-type key: ${rule.spaceTypeKey}`
    );
  }
}

function normalise(value: string): string {
  return value.toLowerCase();
}

/**
 * Heuristic match. Alias regex first (high-precision), then an exact
 * tokenized display-name match against the full space-type list.
 * Returns null when nothing matches — caller should fall back to the LLM.
 */
export function classifyByName(
  space: Pick<SpaceSummary, "name" | "longName">
): SpaceClassification | null {
  const combined = normalise(`${space.name ?? ""} ${space.longName ?? ""}`).trim();
  if (!combined) {
    return null;
  }

  for (const rule of ALIAS_RULES) {
    if (rule.pattern.test(combined)) {
      return {
        spaceGlobalId: "",
        spaceTypeKey: rule.spaceTypeKey,
        confidence: "heuristic"
      };
    }
  }

  // Exact displayName (slug-level) match, e.g. an IFC LongName that already
  // spells "Break Rooms" → key "break-rooms".
  const exact = findExactDisplayNameMatch(combined);
  if (exact) {
    return {
      spaceGlobalId: "",
      spaceTypeKey: exact.key,
      confidence: "heuristic"
    };
  }

  return null;
}

function findExactDisplayNameMatch(needle: string): SpaceTypeEntry | null {
  for (const entry of SPACE_TYPES) {
    if (normalise(entry.displayName) === needle) {
      return entry;
    }
  }
  return null;
}

export type ClassifySpacesOptions = {
  /** Invoked for spaces the heuristic cannot classify. Must resolve every
   *  input space to a valid ASHRAE key or throw. */
  llmClassifier?: (spaces: SpaceSummary[]) => Promise<Map<string, string>>;
};

/**
 * Classifies every space. Heuristic-first; unmatched spaces are batched into
 * the optional LLM classifier. Fails loud if any space is left unclassified
 * (per project rule: no silent fallbacks).
 */
export async function classifySpaces(
  spaces: SpaceSummary[],
  options: ClassifySpacesOptions = {}
): Promise<Map<string, SpaceClassification>> {
  const results = new Map<string, SpaceClassification>();
  const unmatched: SpaceSummary[] = [];

  for (const space of spaces) {
    const heuristic = classifyByName(space);
    if (heuristic) {
      results.set(space.globalId, { ...heuristic, spaceGlobalId: space.globalId });
      continue;
    }
    unmatched.push(space);
  }

  if (unmatched.length > 0) {
    if (!options.llmClassifier) {
      throw new Error(
        `Heuristic classifier could not resolve ${unmatched.length} space(s) and no LLM classifier was provided: ` +
          unmatched.map((s) => `${s.globalId} (${s.name})`).slice(0, 5).join(", ")
      );
    }
    const llmMap = await options.llmClassifier(unmatched);
    for (const space of unmatched) {
      const key = llmMap.get(space.globalId);
      if (!key) {
        throw new Error(
          `LLM classifier did not return a space-type for ${space.globalId} (${space.name}).`
        );
      }
      if (!tryGetSpaceType(key)) {
        throw new Error(
          `LLM classifier returned unknown space-type key "${key}" for ${space.globalId} (${space.name}).`
        );
      }
      results.set(space.globalId, {
        spaceGlobalId: space.globalId,
        spaceTypeKey: key,
        confidence: "llm"
      });
    }
  }

  return results;
}
