import type {
  ElementSummary,
  SpaceBoundary,
  SpaceLoad,
  SpaceSummary,
  StoreyLoads
} from "../../types";
import { getSpaceType } from "./space-types";
import type { SpaceClassification } from "./classify";
import type { ResolvedClimate } from "./climate";
import { classifyAssembly, type AssemblyClass } from "./assemblies";
import { computeEnvelope, describeEnvelope } from "./envelope";
import { computeThermal, type SolarGlazingSurface } from "./thermal";
import { computeVentilation, defaultOccupants } from "./ventilation";

const SQ_METERS_TO_SQ_FEET = 10.7639;
const SOLAR_GLAZING_CLASSES = new Set<AssemblyClass>([
  "fenestration-vertical",
  "fenestration-skylight",
  "door-glass"
]);

function isSolarGlazingAssembly(
  assembly: AssemblyClass
): assembly is SolarGlazingSurface["assemblyClass"] {
  return SOLAR_GLAZING_CLASSES.has(assembly);
}

export type StoreyLoadsInput = {
  modelId: string;
  planVersion: number;
  storeyGlobalId: string;
  spaces: SpaceSummary[];
  classifications: Map<string, SpaceClassification>;
  /** Project length unit as reported by the IFC schema. */
  lengthUnit: string;
  /** Envelope inputs. Omit them and loads fall back to interior-only behavior
   *  (envelope conduction contributes 0) — preserves pre-envelope callers and
   *  models without space boundaries or a resolvable site location. */
  boundariesBySpaceGlobalId?: Map<string, SpaceBoundary[]>;
  elementsByGlobalId?: Map<string, ElementSummary>;
  climate?: ResolvedClimate | null;
};

function areaSqft(
  area: number | null,
  lengthUnit: string,
  space: SpaceSummary
): number {
  if (area === null || !Number.isFinite(area) || area <= 0) {
    throw new Error(
      `Space ${space.globalId} (${space.name}) has no usable floor area (got ${area}). ` +
        "HVAC loads require a positive area — fix IFC ingestion so every IfcSpace has " +
        "either a property-set area or a mesh-derivable footprint."
    );
  }
  const unit = lengthUnit.toLowerCase();
  if (unit === "foot" || unit === "feet" || unit === "ft") {
    return area;
  }
  if (unit === "metre" || unit === "meter" || unit === "m") {
    return area * SQ_METERS_TO_SQ_FEET;
  }
  throw new Error(
    `Unsupported IFC length unit for load calculation: ${lengthUnit}. Expected metre or foot.`
  );
}

function surfaceInputSummary(
  boundaries: SpaceBoundary[],
  elementsByGlobalId: Map<string, ElementSummary>
): {
  exteriorWallAreaSqft: number;
  glazingAreaSqft: number;
  solarGlazingAreaSqft: number;
  solarGlazingSurfaces: SolarGlazingSurface[];
  diagnostics: string[];
} {
  let exteriorWallAreaSqft = 0;
  let glazingAreaSqft = 0;
  let solarGlazingAreaSqft = 0;
  const solarGlazingSurfaces: SolarGlazingSurface[] = [];
  const diagnostics: string[] = [];

  for (const boundary of boundaries) {
    if (
      boundary.boundaryType !== "physical" ||
      boundary.internalOrExternal !== "external" ||
      !(boundary.areaSqft > 0)
    ) {
      continue;
    }

    const element = elementsByGlobalId.get(boundary.elementGlobalId);
    if (!element) {
      diagnostics.push(
        `envelope input incomplete: missing element for ${boundary.areaSqft.toFixed(1)} ft² surface ${boundary.elementGlobalId}`
      );
      continue;
    }

    const assembly = classifyAssembly(element, boundary.internalOrExternal);
    if (!assembly) {
      continue;
    }

    if (assembly.startsWith("wall-")) {
      exteriorWallAreaSqft += boundary.areaSqft;
      continue;
    }

    if (isSolarGlazingAssembly(assembly)) {
      glazingAreaSqft += boundary.areaSqft;
      if (boundary.orientationDegrees === null) {
        diagnostics.push(
          `envelope input incomplete: glazing surface ${boundary.elementGlobalId} missing orientation; ${boundary.areaSqft.toFixed(1)} ft² excluded from solar`
        );
        continue;
      }
      solarGlazingAreaSqft += boundary.areaSqft;
      solarGlazingSurfaces.push({
        areaSqft: boundary.areaSqft,
        orientationDegrees: boundary.orientationDegrees,
        assemblyClass: assembly
      });
    }
  }

  if (glazingAreaSqft > 0) {
    diagnostics.push(
      `geometric glazing uses total IfcPlate/window area as glass upper bound: ${glazingAreaSqft.toFixed(1)} ft²`
    );
  }
  if (glazingAreaSqft > 0 && exteriorWallAreaSqft === 0) {
    diagnostics.push(
      "envelope input incomplete: exterior wall surface missing; 0.0 ft² reached loads"
    );
  }

  return {
    exteriorWallAreaSqft,
    glazingAreaSqft,
    solarGlazingAreaSqft,
    solarGlazingSurfaces,
    diagnostics
  };
}

export function computeStoreyLoads(input: StoreyLoadsInput): StoreyLoads {
  const spaceLoads: SpaceLoad[] = [];
  const climate = input.climate ?? null;
  const elementsByGlobalId = input.elementsByGlobalId ?? new Map();
  const boundariesBySpaceGlobalId =
    input.boundariesBySpaceGlobalId ?? new Map<string, SpaceBoundary[]>();

  for (const space of input.spaces) {
    if (space.storeyGlobalId !== input.storeyGlobalId) {
      continue;
    }
    const classification = input.classifications.get(space.globalId);
    if (!classification) {
      throw new Error(
        `Space ${space.globalId} (${space.name}) has no ASHRAE classification. ` +
          "Classify all spaces before computing loads."
      );
    }

    const spaceType = getSpaceType(classification.spaceTypeKey);
    const area = areaSqft(space.area, input.lengthUnit, space);
    const occupants = defaultOccupants(area, spaceType.occupantDensityPer1000Sqft);

    const diagnostics: string[] = [];

    // Envelope conduction — only when we have both boundaries and a resolved
    // climate; otherwise it contributes 0 (graceful degradation).
    const spaceBoundaries = boundariesBySpaceGlobalId.get(space.globalId) ?? [];
    const surfaceSummary = surfaceInputSummary(spaceBoundaries, elementsByGlobalId);
    diagnostics.push(...surfaceSummary.diagnostics);
    let envelopeBtuH = 0;
    let envelopeBreakdown: Record<string, number> = {};
    if (climate && spaceBoundaries.length > 0) {
      const envelope = computeEnvelope({
        boundaries: spaceBoundaries,
        elementsByGlobalId,
        design: climate.design,
        climateZone: climate.zone
      });
      envelopeBtuH = envelope.envelopeBtuH;
      envelopeBreakdown = envelope.breakdown;
      if (envelopeBtuH > 0) {
        diagnostics.push(describeEnvelope(envelope));
      }
      diagnostics.push(...envelope.diagnostics);
    }
    if (climate && spaceBoundaries.length > 0 && surfaceSummary.exteriorWallAreaSqft === 0 && surfaceSummary.glazingAreaSqft === 0) {
      diagnostics.push(
        "envelope input incomplete: missing exterior wall/glazing surface area; 0.0 ft² reached loads"
      );
    }

    const ventilation = computeVentilation({
      areaSqft: area,
      occupants,
      spaceType
    });
    const thermal = computeThermal({
      areaSqft: area,
      occupants,
      spaceType,
      envelopeBtuH,
      solar:
        climate && surfaceSummary.solarGlazingSurfaces.length > 0
          ? {
              climateZone: climate.zone,
              glazing: surfaceSummary.solarGlazingSurfaces
            }
          : undefined
    });

    const exhaustCfm =
      spaceType.exhaustCfmPerSqft * area + spaceType.exhaustCfmPerUnit;
    const estimatorCfm = spaceType.cfmPerSqftEstimator * area;
    const designCfm = Math.max(
      ventilation.voz,
      thermal.cfm,
      exhaustCfm,
      estimatorCfm
    );

    if (designCfm === 0) {
      diagnostics.push("design CFM is zero — review space classification");
    }
    if (
      exhaustCfm > ventilation.voz &&
      exhaustCfm > thermal.cfm &&
      exhaustCfm >= estimatorCfm
    ) {
      diagnostics.push("design CFM is driven by minimum exhaust rate");
    }
    if (
      spaceType.cfmPerSqftEstimator === 0 &&
      ventilation.voz === 0 &&
      thermal.cfm === 0 &&
      exhaustCfm === 0
    ) {
      diagnostics.push(
        "space-type has no CFM/sqft estimator and no positive load terms — classification may be too coarse"
      );
    }

    spaceLoads.push({
      spaceGlobalId: space.globalId,
      storeyGlobalId: input.storeyGlobalId,
      spaceTypeKey: classification.spaceTypeKey,
      spaceTypeDisplayName: spaceType.displayName,
      classificationConfidence: classification.confidence,
      areaSqft: area,
      occupants,
      ventilation: {
        ra: ventilation.ra,
        rp: ventilation.rp,
        ez: ventilation.ez,
        vbz: ventilation.vbz,
        voz: ventilation.voz
      },
      thermal: {
        sensibleLoadBtuH: thermal.sensibleLoadBtuH,
        supplyDeltaTF: thermal.supplyDeltaTF,
        cfm: thermal.cfm,
        internalBtuH: thermal.internalBtuH,
        envelopeBtuH: thermal.envelopeBtuH,
        solarBtuH: thermal.solarBtuH,
        envelopeBreakdown
      },
      estimator: {
        cfmPerSqft: spaceType.cfmPerSqftEstimator,
        cfm: estimatorCfm
      },
      designCfm,
      diagnostics
    });
  }

  const totals = spaceLoads.reduce(
    (acc, entry) => {
      acc.designCfm += entry.designCfm;
      acc.ventilationCfm += entry.ventilation.voz;
      acc.sensibleLoadBtuH += entry.thermal.sensibleLoadBtuH;
      acc.envelopeBtuH += entry.thermal.envelopeBtuH;
      acc.solarBtuH += entry.thermal.solarBtuH;
      acc.spaceCount += 1;
      return acc;
    },
    {
      designCfm: 0,
      ventilationCfm: 0,
      sensibleLoadBtuH: 0,
      envelopeBtuH: 0,
      solarBtuH: 0,
      spaceCount: 0
    }
  );

  return {
    modelId: input.modelId,
    storeyGlobalId: input.storeyGlobalId,
    planVersion: input.planVersion,
    spaces: spaceLoads,
    totals,
    climate: climate
      ? {
          zone: climate.zone,
          representativeCity: climate.representativeCity,
          coolingDryBulbF: climate.design.coolingDryBulbF,
          heatingDryBulbF: climate.design.heatingDryBulbF
        }
      : null
  };
}
