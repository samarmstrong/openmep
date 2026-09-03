import type { SpaceTypeEntry } from "./space-types";

export const DEFAULT_ZONE_AIR_DISTRIBUTION_EFFECTIVENESS = 0.8;

export type VentilationInput = {
  areaSqft: number;
  occupants: number;
  spaceType: Pick<SpaceTypeEntry, "ra" | "rp">;
  ez?: number;
};

export type VentilationResult = {
  ra: number;
  rp: number;
  ez: number;
  vbz: number;
  voz: number;
};

export function computeVentilation(input: VentilationInput): VentilationResult {
  const { areaSqft, occupants } = input;
  const ra = input.spaceType.ra;
  const rp = input.spaceType.rp;
  const ez = input.ez ?? DEFAULT_ZONE_AIR_DISTRIBUTION_EFFECTIVENESS;

  if (!(ez > 0)) {
    throw new Error(`Zone air distribution effectiveness must be > 0, got ${ez}.`);
  }
  if (areaSqft < 0) {
    throw new Error(`Area must be >= 0, got ${areaSqft}.`);
  }
  if (occupants < 0) {
    throw new Error(`Occupant count must be >= 0, got ${occupants}.`);
  }

  const vbz = rp * occupants + ra * areaSqft;
  const voz = vbz / ez;

  return { ra, rp, ez, vbz, voz };
}

export function defaultOccupants(
  areaSqft: number,
  densityPer1000Sqft: number
): number {
  if (areaSqft <= 0 || densityPer1000Sqft <= 0) {
    return 0;
  }
  return Math.ceil((areaSqft * densityPer1000Sqft) / 1000);
}
