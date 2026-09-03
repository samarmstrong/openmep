import type { ElementSummary } from "../../types";
import type { ClimateZone } from "./climate";

/**
 * Code-minimum envelope assembly properties (U-factor, SHGC) keyed by
 * construction class and ASHRAE 90.1-2019 climate zone, plus a heuristic that
 * maps an IFC element to its assembly class.
 *
 * The IFC architectural export carries no thermal material properties (no
 * IfcMaterialProperties, no U-values), so until a later iteration parses
 * IfcMaterialLayerSet, we assume each assembly is built to the ASHRAE 90.1-2019
 * prescriptive maximum for its climate zone. Values below are the
 * nonresidential prescriptive U-factors / SHGC from 90.1-2019 Tables 5.5-1..8,
 * rounded to representative numbers. They are intentionally code-minimum
 * defaults — conservative and overridable per-assembly in a later iteration.
 */

export type AssemblyClass =
  | "wall-mass"
  | "wall-steel-frame"
  | "wall-wood-frame"
  | "wall-metal-building"
  | "wall-below-grade"
  | "roof-above-deck"
  | "roof-attic"
  | "roof-metal-building"
  | "slab-on-grade-unheated"
  | "slab-on-grade-heated"
  | "fenestration-vertical"
  | "fenestration-skylight"
  | "door-opaque"
  | "door-glass";

export type AssemblyDefaults = {
  /** Assembly U-factor, Btu/(h·ft²·°F). */
  uValueBtuHrFt2F: number;
  /** Solar heat gain coefficient (fenestration + glass doors only). */
  shgc?: number;
};

export type BoundaryExposure = "internal" | "external" | "external-earth";

/** ASHRAE 90.1 zone number (1-8) for each lettered zone. Most U-factors depend
 *  on the number alone, not the A/B/C moisture suffix. */
const ZONE_NUMBER: Record<ClimateZone, number> = {
  "1A": 1,
  "2A": 2,
  "2B": 2,
  "3A": 3,
  "3B": 3,
  "3C": 3,
  "4A": 4,
  "4B": 4,
  "4C": 4,
  "5A": 5,
  "5B": 5,
  "6A": 6,
  "6B": 6,
  "7": 7,
  "8": 8
};

// Each array is indexed by (zoneNumber - 1), i.e. [zone1 ... zone8].
const U_FACTOR_BY_ZONE: Record<AssemblyClass, readonly number[]> = {
  "wall-mass": [0.58, 0.151, 0.123, 0.104, 0.09, 0.08, 0.071, 0.061],
  "wall-steel-frame": [0.124, 0.084, 0.084, 0.064, 0.064, 0.064, 0.052, 0.045],
  "wall-wood-frame": [0.089, 0.089, 0.064, 0.064, 0.051, 0.051, 0.051, 0.045],
  "wall-metal-building": [0.079, 0.079, 0.079, 0.052, 0.052, 0.052, 0.052, 0.042],
  "wall-below-grade": [0.119, 0.119, 0.119, 0.092, 0.092, 0.075, 0.075, 0.075],
  "roof-above-deck": [0.048, 0.039, 0.039, 0.032, 0.032, 0.032, 0.028, 0.028],
  "roof-attic": [0.027, 0.027, 0.021, 0.021, 0.021, 0.021, 0.021, 0.017],
  "roof-metal-building": [0.055, 0.055, 0.044, 0.035, 0.035, 0.031, 0.029, 0.029],
  // Slab F-factor (per-perimeter-foot) modeling is deferred; these are nominal
  // effective area U-factors. For cooling, slab ΔT is usually clamped to 0
  // (ground cooler than the indoor setpoint), so these rarely bind this pass.
  "slab-on-grade-unheated": [0.1, 0.1, 0.1, 0.073, 0.073, 0.054, 0.054, 0.054],
  "slab-on-grade-heated": [0.15, 0.15, 0.15, 0.12, 0.12, 0.1, 0.1, 0.1],
  "fenestration-vertical": [0.5, 0.5, 0.46, 0.38, 0.38, 0.36, 0.29, 0.29],
  "fenestration-skylight": [0.75, 0.65, 0.55, 0.5, 0.5, 0.5, 0.5, 0.5],
  "door-opaque": [0.61, 0.61, 0.61, 0.37, 0.37, 0.37, 0.37, 0.37],
  "door-glass": [0.5, 0.5, 0.46, 0.38, 0.38, 0.36, 0.29, 0.29]
};

const SHGC_BY_ZONE: Partial<Record<AssemblyClass, readonly number[]>> = {
  "fenestration-vertical": [0.22, 0.22, 0.24, 0.36, 0.38, 0.4, 0.45, 0.45],
  "fenestration-skylight": [0.35, 0.35, 0.35, 0.4, 0.4, 0.4, 0.45, 0.45],
  "door-glass": [0.22, 0.22, 0.24, 0.36, 0.38, 0.4, 0.45, 0.45]
};

export function getAssemblyDefaults(
  assemblyClass: AssemblyClass,
  zone: ClimateZone
): AssemblyDefaults {
  const zoneIndex = ZONE_NUMBER[zone] - 1;
  const uFactors = U_FACTOR_BY_ZONE[assemblyClass];
  const uValueBtuHrFt2F = uFactors[zoneIndex];
  if (uValueBtuHrFt2F === undefined) {
    throw new Error(
      `No code-minimum U-factor for assembly ${assemblyClass} in zone ${zone}.`
    );
  }
  const shgc = SHGC_BY_ZONE[assemblyClass]?.[zoneIndex];
  return shgc === undefined
    ? { uValueBtuHrFt2F }
    : { uValueBtuHrFt2F, shgc };
}

/** Lowercased haystack of an element's free-text fields for keyword matching. */
function elementText(element: ElementSummary): string {
  return [element.name, element.longName, element.objectType, element.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

/**
 * Map an IFC element to its envelope assembly class. Returns null for element
 * classes that never form the thermal envelope (columns, beams, members,
 * coverings, furniture, proxies) — the envelope calculator skips those.
 *
 * The exterior/interior/earth distinction is NOT decided here — it comes from
 * the IfcRelSpaceBoundary's InternalOrExternalBoundary flag, which the caller
 * passes as `exposure` so slabs can be split into roof vs. ground.
 */
export function classifyAssembly(
  element: ElementSummary,
  exposure?: BoundaryExposure
): AssemblyClass | null {
  const ifcClass = element.ifcClass.toUpperCase();
  const text = elementText(element);

  if (ifcClass === "IFCWALL" || ifcClass === "IFCWALLSTANDARDCASE") {
    if (/curtain|storefront|glaz|glass/.test(text)) {
      return "fenestration-vertical";
    }
    if (/cmu|masonry|concrete|brick|block|precast/.test(text)) {
      return "wall-mass";
    }
    if (/metal building|metal-building/.test(text)) {
      return "wall-metal-building";
    }
    if (/wood|timber/.test(text)) {
      return "wall-wood-frame";
    }
    if (exposure === "external-earth" || /below.?grade|foundation|basement/.test(text)) {
      return "wall-below-grade";
    }
    return "wall-steel-frame";
  }

  if (ifcClass === "IFCCURTAINWALL") {
    return "fenestration-vertical";
  }

  if (ifcClass === "IFCWINDOW") {
    return /skylight|roof light|rooflight/.test(text)
      ? "fenestration-skylight"
      : "fenestration-vertical";
  }

  if (ifcClass === "IFCPLATE") {
    // Revit curtain walls often decompose glass/spandrel panels into IfcPlate
    // children while the parent IfcCurtainWall has no mesh. Treat all plates as
    // vertical fenestration until a later glass-vs-spandrel split is available.
    return /skylight|roof light|rooflight/.test(text)
      ? "fenestration-skylight"
      : "fenestration-vertical";
  }

  if (ifcClass === "IFCDOOR") {
    return /glass|glaz|alum|storefront/.test(text) ? "door-glass" : "door-opaque";
  }

  if (ifcClass === "IFCROOF") {
    if (/metal/.test(text)) return "roof-metal-building";
    if (/attic/.test(text)) return "roof-attic";
    return "roof-above-deck";
  }

  if (ifcClass === "IFCSLAB") {
    if (exposure === "external-earth") {
      return /heated/.test(text) ? "slab-on-grade-heated" : "slab-on-grade-unheated";
    }
    if (/roof/.test(text) || exposure === "external") {
      return "roof-above-deck";
    }
    return "slab-on-grade-unheated";
  }

  return null;
}
