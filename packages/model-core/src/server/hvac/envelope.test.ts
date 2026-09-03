import { describe, expect, it } from "vitest";

import type { ElementSummary, SpaceBoundary } from "../../types";
import { getAssemblyDefaults } from "./assemblies";
import { getDesignConditions } from "./climate";
import { computeEnvelope } from "./envelope";

const roofU5A = getAssemblyDefaults("roof-above-deck", "5A").uValueBtuHrFt2F;

function element(globalId: string, overrides: Partial<ElementSummary>): ElementSummary {
  return {
    modelId: "m1",
    sourceId: "architecture",
    discipline: "architecture",
    expressId: 1,
    sourceGlobalId: globalId,
    globalId,
    compositeGlobalId: globalId,
    ifcClass: "IFCWALL",
    name: null,
    longName: null,
    description: null,
    objectType: null,
    tag: null,
    storeyGlobalId: "s1",
    spaceGlobalId: null,
    placement: null,
    airflowType: "unknown",
    systemAssignments: [],
    properties: {},
    ...overrides
  };
}

function boundary(overrides: Partial<SpaceBoundary>): SpaceBoundary {
  return {
    modelId: "m1",
    spaceGlobalId: "space-1",
    elementGlobalId: "wall-1",
    boundaryType: "physical",
    internalOrExternal: "external",
    areaSqft: 100,
    orientationDegrees: null,
    ...overrides
  };
}

const DESIGN_5A = getDesignConditions("5A"); // cooling DB 89°F, indoor 75°F → ΔT 14

describe("computeEnvelope", () => {
  it("matches a hand calc for a single external steel-frame wall (5A)", () => {
    const elements = new Map([["wall-1", element("wall-1", { name: "Basic Wall" })]]);
    const result = computeEnvelope({
      boundaries: [boundary({})],
      elementsByGlobalId: elements,
      design: DESIGN_5A,
      climateZone: "5A"
    });
    // U 0.064 × A 100 ft² × ΔT (89 − 75) = 89.6 Btu/h
    expect(result.envelopeBtuH).toBeCloseTo(0.064 * 100 * 14, 1);
    expect(result.breakdown["wall-steel-frame"]).toBeCloseTo(89.6, 1);
  });

  it("sums multiple surfaces and breaks them down by assembly class", () => {
    const elements = new Map<string, ElementSummary>([
      ["wall-1", element("wall-1", { name: "Basic Wall" })],
      ["roof-1", element("roof-1", { ifcClass: "IFCROOF", name: "Flat Roof" })],
      ["slab-1", element("slab-1", { ifcClass: "IFCSLAB", name: "Floor" })]
    ]);
    const result = computeEnvelope({
      boundaries: [
        boundary({ elementGlobalId: "wall-1", areaSqft: 100 }),
        boundary({ elementGlobalId: "roof-1", areaSqft: 200, internalOrExternal: "external" }),
        boundary({ elementGlobalId: "slab-1", areaSqft: 200, internalOrExternal: "external-earth" })
      ],
      elementsByGlobalId: elements,
      design: DESIGN_5A,
      climateZone: "5A"
    });

    const wall = 0.064 * 100 * 14;
    const roof = roofU5A * 200 * 14;
    expect(result.breakdown["wall-steel-frame"]).toBeCloseTo(wall, 1);
    expect(result.breakdown["roof-above-deck"]).toBeCloseTo(roof, 1);
    // Ground (51°F) is below the 75°F cooling setpoint → slab adds 0 cooling load.
    expect(result.breakdown["slab-on-grade-unheated"] ?? 0).toBe(0);
    expect(result.envelopeBtuH).toBeCloseTo(wall + roof, 1);
  });

  it("skips internal, virtual, and unclassifiable boundaries", () => {
    const elements = new Map<string, ElementSummary>([
      ["wall-int", element("wall-int", { name: "Partition" })],
      ["col-1", element("col-1", { ifcClass: "IFCCOLUMN", name: "Column" })]
    ]);
    const result = computeEnvelope({
      boundaries: [
        boundary({ elementGlobalId: "wall-int", internalOrExternal: "internal" }),
        boundary({ elementGlobalId: "wall-ext", boundaryType: "virtual" }),
        boundary({ elementGlobalId: "col-1", internalOrExternal: "external" }),
        boundary({ elementGlobalId: "missing", internalOrExternal: "external" })
      ],
      elementsByGlobalId: elements,
      design: DESIGN_5A,
      climateZone: "5A"
    });
    expect(result.envelopeBtuH).toBe(0);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
