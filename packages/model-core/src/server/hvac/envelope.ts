import type { ElementSummary, SpaceBoundary } from "../../types";
import {
  classifyAssembly,
  getAssemblyDefaults,
  type AssemblyClass
} from "./assemblies";
import type { ClimateZone, DesignConditions } from "./climate";

/**
 * Steady-state envelope conduction for peak cooling: q = U · A · ΔT summed over
 * every exterior surface that bounds a space.
 *
 * This is the first envelope term toward Trace-700-style loads. It does NOT yet
 * include solar gain through glazing, sol-air temperature for opaque surfaces,
 * hour-of-day RTS/CTS lag, infiltration, or latent — those are later
 * iterations. Orientation is captured on each boundary but unused here (it
 * feeds the future solar pass).
 */

export type EnvelopeInput = {
  boundaries: SpaceBoundary[];
  elementsByGlobalId: Map<string, ElementSummary>;
  design: DesignConditions;
  climateZone: ClimateZone;
};

export type EnvelopeResult = {
  /** Total conduction gain across exterior boundaries, Btu/h. */
  envelopeBtuH: number;
  /** Conduction gain split by assembly class, Btu/h. */
  breakdown: Record<string, number>;
  diagnostics: string[];
};

export function computeEnvelope(input: EnvelopeInput): EnvelopeResult {
  const { boundaries, elementsByGlobalId, design, climateZone } = input;
  const breakdown: Record<string, number> = {};
  const diagnostics: string[] = [];
  let envelopeBtuH = 0;

  const coolingDeltaT = design.coolingDryBulbF - design.indoorCoolingSetpointF;
  // Ground is usually cooler than the indoor cooling setpoint, so slab/below-
  // grade surfaces add no cooling load; clamp to 0 rather than crediting them.
  const earthDeltaT = Math.max(0, design.groundTempF - design.indoorCoolingSetpointF);

  for (const boundary of boundaries) {
    if (boundary.boundaryType !== "physical") {
      continue;
    }
    if (boundary.internalOrExternal === "internal") {
      // Single-zone-temperature model: interior partitions carry no design load.
      continue;
    }
    if (!(boundary.areaSqft > 0)) {
      diagnostics.push(
        `boundary on ${boundary.elementGlobalId} has no usable area — skipped`
      );
      continue;
    }

    const element = elementsByGlobalId.get(boundary.elementGlobalId);
    if (!element) {
      diagnostics.push(
        `boundary references missing element ${boundary.elementGlobalId} — skipped`
      );
      continue;
    }

    const assemblyClass: AssemblyClass | null = classifyAssembly(
      element,
      boundary.internalOrExternal
    );
    if (!assemblyClass) {
      diagnostics.push(
        `${element.ifcClass} ${element.globalId} is not an envelope assembly — skipped`
      );
      continue;
    }

    const { uValueBtuHrFt2F } = getAssemblyDefaults(assemblyClass, climateZone);
    const deltaT =
      boundary.internalOrExternal === "external-earth" ? earthDeltaT : coolingDeltaT;
    const qBtuH = uValueBtuHrFt2F * boundary.areaSqft * deltaT;

    envelopeBtuH += qBtuH;
    breakdown[assemblyClass] = (breakdown[assemblyClass] ?? 0) + qBtuH;
  }

  return { envelopeBtuH, breakdown, diagnostics };
}

/** One-line human summary of an envelope result for space diagnostics. */
export function describeEnvelope(result: EnvelopeResult): string {
  const parts = Object.entries(result.breakdown)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key} ${Math.round(value)}`);
  return `envelope: ${Math.round(result.envelopeBtuH)} Btu/h${
    parts.length ? ` (${parts.join(", ")})` : ""
  }`;
}
