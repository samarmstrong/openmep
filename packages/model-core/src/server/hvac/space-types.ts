import { z } from "zod";

import rawSpaceTypes from "./space-types.json" with { type: "json" };

const spaceTypeEntrySchema = z.object({
  key: z.string().min(1),
  displayName: z.string().min(1),
  ra: z.number().nonnegative(),
  rp: z.number().nonnegative(),
  occupantDensityPer1000Sqft: z.number().nonnegative(),
  lightingWPerSqft: z.number().nonnegative(),
  equipmentWPerSqft: z.number().nonnegative(),
  peopleSensibleBtuhPerPerson: z.number().nonnegative(),
  peopleLatentBtuhPerPerson: z.number().nonnegative(),
  exhaustCfmPerSqft: z.number().nonnegative(),
  exhaustCfmPerUnit: z.number().nonnegative(),
  cfmPerSqftEstimator: z.number().nonnegative()
});

export type SpaceTypeEntry = z.infer<typeof spaceTypeEntrySchema>;

const spaceTypesFileSchema = z.object({
  source: z.string(),
  note: z.string(),
  entryCount: z.number().int().nonnegative(),
  entries: z.array(spaceTypeEntrySchema).min(1)
});

const parsed = spaceTypesFileSchema.parse(rawSpaceTypes);

if (parsed.entries.length !== parsed.entryCount) {
  throw new Error(
    `space-types.json entryCount (${parsed.entryCount}) does not match entries.length (${parsed.entries.length}).`
  );
}

const entriesByKey = new Map<string, SpaceTypeEntry>(
  parsed.entries.map((entry) => [entry.key, entry])
);

export const SPACE_TYPES: readonly SpaceTypeEntry[] = parsed.entries;

export const SPACE_TYPE_KEYS: readonly string[] = parsed.entries.map((entry) => entry.key);

export function getSpaceType(key: string): SpaceTypeEntry {
  const entry = entriesByKey.get(key);
  if (!entry) {
    throw new Error(`Unknown ASHRAE 62.1 space-type key: ${key}`);
  }
  return entry;
}

export function tryGetSpaceType(key: string): SpaceTypeEntry | null {
  return entriesByKey.get(key) ?? null;
}
