/**
 * Climate zone + outdoor design conditions.
 *
 * Trane Trace 700 drives peak loads from location-specific outdoor design
 * conditions (ASHRAE Fundamentals Ch. 14: the 0.4% cooling dry-bulb / mean
 * coincident wet-bulb and the 99.6% heating dry-bulb columns). This module is
 * the first piece of that: it maps an IfcSite latitude/longitude to an
 * ASHRAE 90.1 climate zone and returns representative design conditions for the
 * zone.
 *
 * INTENTIONALLY COARSE — climate zone is resolved by nearest representative
 * city (one anchor per US zone) rather than a proper county/shapefile lookup,
 * and design conditions are a single representative city per zone rather than
 * the full per-station ASHRAE tables. This is good enough to seed envelope
 * conduction; replace with a station-resolved dataset in a later iteration.
 */

export const CLIMATE_ZONES = [
  "1A",
  "2A",
  "2B",
  "3A",
  "3B",
  "3C",
  "4A",
  "4B",
  "4C",
  "5A",
  "5B",
  "6A",
  "6B",
  "7",
  "8"
] as const;

export type ClimateZone = (typeof CLIMATE_ZONES)[number];

export type DesignConditions = {
  /** ASHRAE 0.4% cooling design dry-bulb, °F. */
  coolingDryBulbF: number;
  /** Mean coincident wet-bulb at the 0.4% cooling dry-bulb, °F. */
  coolingWetBulbF: number;
  /** ASHRAE 99.6% heating design dry-bulb, °F. */
  heatingDryBulbF: number;
  /** Deep-ground / annual-average temperature, °F (slab + below-grade ΔT). */
  groundTempF: number;
  /** Indoor cooling setpoint, °F. */
  indoorCoolingSetpointF: number;
  /** Indoor heating setpoint, °F. */
  indoorHeatingSetpointF: number;
};

export type SiteLocation = {
  latitude: number | null;
  longitude: number | null;
};

export type ResolvedClimate = {
  zone: ClimateZone;
  /** Representative city used as the zone anchor (for diagnostics/UI). */
  representativeCity: string;
  design: DesignConditions;
};

const INDOOR_COOLING_SETPOINT_F = 75;
const INDOOR_HEATING_SETPOINT_F = 70;

type ZoneAnchor = {
  zone: ClimateZone;
  city: string;
  latitude: number;
  longitude: number;
  coolingDryBulbF: number;
  coolingWetBulbF: number;
  heatingDryBulbF: number;
  groundTempF: number;
};

/**
 * One representative US city per ASHRAE 90.1 climate zone. Design conditions
 * are approximate ASHRAE Fundamentals Ch. 14 values (0.4% cooling DB/MCWB,
 * 99.6% heating DB) for the listed city; groundTempF ≈ annual-average air temp.
 */
const ZONE_ANCHORS: readonly ZoneAnchor[] = [
  { zone: "1A", city: "Miami, FL", latitude: 25.76, longitude: -80.19, coolingDryBulbF: 91, coolingWetBulbF: 77, heatingDryBulbF: 50, groundTempF: 77 },
  { zone: "2A", city: "Houston, TX", latitude: 29.76, longitude: -95.37, coolingDryBulbF: 96, coolingWetBulbF: 77, heatingDryBulbF: 32, groundTempF: 69 },
  { zone: "2B", city: "Phoenix, AZ", latitude: 33.45, longitude: -112.07, coolingDryBulbF: 108, coolingWetBulbF: 70, heatingDryBulbF: 37, groundTempF: 75 },
  { zone: "3A", city: "Atlanta, GA", latitude: 33.75, longitude: -84.39, coolingDryBulbF: 93, coolingWetBulbF: 74, heatingDryBulbF: 23, groundTempF: 62 },
  { zone: "3B", city: "El Paso, TX", latitude: 31.76, longitude: -106.49, coolingDryBulbF: 100, coolingWetBulbF: 64, heatingDryBulbF: 26, groundTempF: 64 },
  { zone: "3C", city: "San Francisco, CA", latitude: 37.77, longitude: -122.42, coolingDryBulbF: 83, coolingWetBulbF: 63, heatingDryBulbF: 42, groundTempF: 57 },
  { zone: "4A", city: "Baltimore, MD", latitude: 39.29, longitude: -76.61, coolingDryBulbF: 91, coolingWetBulbF: 75, heatingDryBulbF: 17, groundTempF: 56 },
  { zone: "4B", city: "Albuquerque, NM", latitude: 35.08, longitude: -106.65, coolingDryBulbF: 96, coolingWetBulbF: 61, heatingDryBulbF: 19, groundTempF: 57 },
  { zone: "4C", city: "Seattle, WA", latitude: 47.61, longitude: -122.33, coolingDryBulbF: 85, coolingWetBulbF: 65, heatingDryBulbF: 27, groundTempF: 52 },
  { zone: "5A", city: "Boston, MA", latitude: 42.36, longitude: -71.06, coolingDryBulbF: 89, coolingWetBulbF: 73, heatingDryBulbF: 9, groundTempF: 51 },
  { zone: "5B", city: "Denver, CO", latitude: 39.74, longitude: -104.99, coolingDryBulbF: 93, coolingWetBulbF: 60, heatingDryBulbF: 1, groundTempF: 50 },
  { zone: "6A", city: "Minneapolis, MN", latitude: 44.98, longitude: -93.27, coolingDryBulbF: 91, coolingWetBulbF: 73, heatingDryBulbF: -11, groundTempF: 45 },
  { zone: "6B", city: "Helena, MT", latitude: 46.59, longitude: -112.04, coolingDryBulbF: 90, coolingWetBulbF: 60, heatingDryBulbF: -10, groundTempF: 43 },
  { zone: "7", city: "Duluth, MN", latitude: 46.79, longitude: -92.1, coolingDryBulbF: 85, coolingWetBulbF: 70, heatingDryBulbF: -16, groundTempF: 39 },
  { zone: "8", city: "Fairbanks, AK", latitude: 64.84, longitude: -147.72, coolingDryBulbF: 82, coolingWetBulbF: 62, heatingDryBulbF: -42, groundTempF: 27 }
];

const ANCHOR_BY_ZONE = new Map<ClimateZone, ZoneAnchor>(
  ZONE_ANCHORS.map((anchor) => [anchor.zone, anchor])
);

function toDesignConditions(anchor: ZoneAnchor): DesignConditions {
  return {
    coolingDryBulbF: anchor.coolingDryBulbF,
    coolingWetBulbF: anchor.coolingWetBulbF,
    heatingDryBulbF: anchor.heatingDryBulbF,
    groundTempF: anchor.groundTempF,
    indoorCoolingSetpointF: INDOOR_COOLING_SETPOINT_F,
    indoorHeatingSetpointF: INDOOR_HEATING_SETPOINT_F
  };
}

/**
 * Squared great-circle-ish distance using an equirectangular approximation.
 * Adequate for nearest-anchor selection; we never need the actual distance.
 */
function anchorDistanceSq(
  latitude: number,
  longitude: number,
  anchor: ZoneAnchor
): number {
  const meanLatRad = ((latitude + anchor.latitude) / 2) * (Math.PI / 180);
  const dLat = latitude - anchor.latitude;
  const dLon = (longitude - anchor.longitude) * Math.cos(meanLatRad);
  return dLat * dLat + dLon * dLon;
}

/**
 * Resolve an ASHRAE 90.1 climate zone for a coordinate by nearest representative
 * city. Coarse by design (see module header).
 */
export function getClimateZone(latitude: number, longitude: number): ClimateZone {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(
      `getClimateZone requires finite coordinates, got (${latitude}, ${longitude}).`
    );
  }

  let best: ZoneAnchor = ZONE_ANCHORS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of ZONE_ANCHORS) {
    const distance = anchorDistanceSq(latitude, longitude, anchor);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = anchor;
    }
  }
  return best.zone;
}

export function getDesignConditions(zone: ClimateZone): DesignConditions {
  const anchor = ANCHOR_BY_ZONE.get(zone);
  if (!anchor) {
    throw new Error(`No design conditions for unknown climate zone: ${zone}.`);
  }
  return toDesignConditions(anchor);
}

/**
 * Resolve climate from an IfcSite location. Returns null when the site has no
 * usable coordinates — the caller then skips envelope conduction (graceful
 * degradation, same as a model without space boundaries) rather than guessing
 * a location.
 */
export function resolveClimate(site: SiteLocation): ResolvedClimate | null {
  if (
    site.latitude === null ||
    site.longitude === null ||
    !Number.isFinite(site.latitude) ||
    !Number.isFinite(site.longitude)
  ) {
    return null;
  }
  const zone = getClimateZone(site.latitude, site.longitude);
  const anchor = ANCHOR_BY_ZONE.get(zone)!;
  return {
    zone,
    representativeCity: anchor.city,
    design: toDesignConditions(anchor)
  };
}
