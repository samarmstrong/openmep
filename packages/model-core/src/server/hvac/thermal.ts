import type { SpaceTypeEntry } from "./space-types";
import { getAssemblyDefaults, type AssemblyClass } from "./assemblies";
import type { ClimateZone } from "./climate";

export const DEFAULT_SUPPLY_DELTA_T_F = 20;

const WATTS_TO_BTUH = 3.412;
const CFM_SENSIBLE_CONSTANT = 1.08;
const ORIENTATION_SOLAR_PEAK_BTUH_PER_FT2: Record<string, number> = {
  N: 110,
  NE: 165,
  E: 235,
  SE: 200,
  S: 180,
  SW: 200,
  W: 235,
  NW: 165
};

export type SolarGlazingSurface = {
  areaSqft: number;
  orientationDegrees: number | null;
  assemblyClass: Extract<
    AssemblyClass,
    "fenestration-vertical" | "fenestration-skylight" | "door-glass"
  >;
};

export type ThermalInput = {
  areaSqft: number;
  occupants: number;
  spaceType: Pick<
    SpaceTypeEntry,
    "lightingWPerSqft" | "equipmentWPerSqft" | "peopleSensibleBtuhPerPerson"
  >;
  supplyDeltaTF?: number;
  /** Envelope conduction gain (U·A·ΔT), Btu/h. Defaults to 0 for callers that
   *  don't model the envelope (e.g. interior-only estimates and legacy tests). */
  envelopeBtuH?: number;
  solar?: {
    climateZone: ClimateZone;
    glazing: SolarGlazingSurface[];
  };
};

export type ThermalResult = {
  sensibleLoadBtuH: number;
  /** Internal sensible gain only (lighting + equipment + people), Btu/h. */
  internalBtuH: number;
  /** Envelope conduction gain echoed through for reporting, Btu/h. */
  envelopeBtuH: number;
  /** Solar gain through glazing, Btu/h. */
  solarBtuH: number;
  supplyDeltaTF: number;
  cfm: number;
};

function orientationBucket(orientationDegrees: number | null): keyof typeof ORIENTATION_SOLAR_PEAK_BTUH_PER_FT2 {
  if (orientationDegrees === null || !Number.isFinite(orientationDegrees)) {
    throw new Error(
      "Solar load requires orientationDegrees for every glazing surface."
    );
  }
  const buckets = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
  const normalized = (orientationDegrees % 360 + 360) % 360;
  return buckets[Math.round(normalized / 45) % buckets.length];
}

function computeSolarBtuH(input: NonNullable<ThermalInput["solar"]>): number {
  return input.glazing.reduce((sum, surface) => {
    if (!(surface.areaSqft > 0)) {
      throw new Error(
        `Solar load requires positive glazing area, got ${surface.areaSqft} ft².`
      );
    }
    const { shgc } = getAssemblyDefaults(surface.assemblyClass, input.climateZone);
    if (shgc === undefined) {
      throw new Error(
        `No SHGC available for ${surface.assemblyClass} in climate zone ${input.climateZone}.`
      );
    }
    const bucket = orientationBucket(surface.orientationDegrees);
    return sum + surface.areaSqft * shgc * ORIENTATION_SOLAR_PEAK_BTUH_PER_FT2[bucket];
  }, 0);
}

/**
 * Sensible cooling load = internal gains (lighting + equipment + people) +
 * envelope conduction (U·A·ΔT, supplied by the caller via computeEnvelope) +
 * solar gain through glazing.
 *
 * Still pending toward full Trace-700 fidelity: sol-air temperature + RTS/CTS
 * hour-of-day lag, latent loads, infiltration, and operating schedules. See
 * the project plan's later iterations.
 */
export function computeThermal(input: ThermalInput): ThermalResult {
  const { areaSqft, occupants, spaceType } = input;
  const supplyDeltaTF = input.supplyDeltaTF ?? DEFAULT_SUPPLY_DELTA_T_F;
  const envelopeBtuH = input.envelopeBtuH ?? 0;
  const solarBtuH = input.solar ? computeSolarBtuH(input.solar) : 0;

  if (!(supplyDeltaTF > 0)) {
    throw new Error(`Supply ΔT must be > 0 °F, got ${supplyDeltaTF}.`);
  }
  if (envelopeBtuH < 0) {
    throw new Error(`Envelope load must be >= 0 Btu/h, got ${envelopeBtuH}.`);
  }
  if (solarBtuH < 0) {
    throw new Error(`Solar load must be >= 0 Btu/h, got ${solarBtuH}.`);
  }

  const internalWatts =
    areaSqft * (spaceType.lightingWPerSqft + spaceType.equipmentWPerSqft);
  const internalBtuh = internalWatts * WATTS_TO_BTUH;
  const peopleBtuh = occupants * spaceType.peopleSensibleBtuhPerPerson;
  const internalBtuH = internalBtuh + peopleBtuh;
  const sensibleLoadBtuH = internalBtuH + envelopeBtuH + solarBtuH;

  const cfm = sensibleLoadBtuH / (CFM_SENSIBLE_CONSTANT * supplyDeltaTF);

  return {
    sensibleLoadBtuH,
    internalBtuH,
    envelopeBtuH,
    solarBtuH,
    supplyDeltaTF,
    cfm
  };
}
