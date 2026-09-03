import { describe, expect, it } from "vitest";

import type { ElementSummary, SpaceBoundary, SpaceSummary } from "../../types";
import {
  LoadInputCoverageError,
  assertLoadInputCoverage,
  summarizeLoadInputCoverage
} from "./load-input-coverage";

function space(globalId: string): SpaceSummary {
  return {
    modelId: "m1",
    sourceId: "architecture",
    discipline: "architecture",
    expressId: 1,
    sourceGlobalId: globalId,
    globalId,
    compositeGlobalId: globalId,
    name: globalId,
    longName: null,
    storeyGlobalId: "s1",
    area: 100,
    placement: null,
    bounds: null,
    properties: {}
  };
}

function element(globalId: string): ElementSummary {
  return {
    modelId: "m1",
    sourceId: "architecture",
    discipline: "architecture",
    expressId: 2,
    sourceGlobalId: globalId,
    globalId,
    compositeGlobalId: globalId,
    ifcClass: "IFCWALLSTANDARDCASE",
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
    properties: {}
  };
}

function boundary(overrides: Partial<SpaceBoundary>): SpaceBoundary {
  return {
    modelId: "m1",
    spaceGlobalId: "space-1",
    elementGlobalId: "wall-1",
    boundaryType: "physical",
    internalOrExternal: "external",
    areaSqft: 120,
    orientationDegrees: 90,
    ...overrides
  };
}

describe("load input coverage", () => {
  it("passes a model with no spaces (mechanical-only source)", () => {
    const coverage = assertLoadInputCoverage({
      spaces: [],
      elements: [element("duct-1")],
      boundaries: []
    });
    expect(coverage.spaceCount).toBe(0);
    expect(coverage.physicalBoundaryCount).toBe(0);
  });

  it("passes and tallies exterior area when physical boundaries exist", () => {
    const coverage = assertLoadInputCoverage({
      spaces: [space("space-1"), space("space-2")],
      elements: [element("wall-1"), element("wall-2")],
      boundaries: [
        boundary({}),
        boundary({ elementGlobalId: "wall-2", internalOrExternal: "internal", areaSqft: 80 }),
        boundary({ elementGlobalId: "wall-2", internalOrExternal: "external-earth", areaSqft: 50 }),
        boundary({ boundaryType: "virtual", elementGlobalId: "", areaSqft: 0 })
      ]
    });
    expect(coverage).toEqual({
      spaceCount: 2,
      elementCount: 2,
      physicalBoundaryCount: 3,
      externalBoundaryCount: 2,
      externalAreaSqft: 170
    });
  });

  it("rejects a rooms-only export: spaces present, every boundary virtual", () => {
    const input = {
      spaces: [space("space-1")],
      elements: [],
      boundaries: [
        boundary({ boundaryType: "virtual", elementGlobalId: "", areaSqft: 0 }),
        boundary({ boundaryType: "virtual", elementGlobalId: "", areaSqft: 0 })
      ]
    };
    expect(() => assertLoadInputCoverage(input)).toThrowError(LoadInputCoverageError);
    expect(() => assertLoadInputCoverage(input)).toThrowError(
      /1 IfcSpace\(s\) but no physical space boundary .*\(0 building element\(s\) in the model, 2 boundaries, all virtual\)/
    );
    expect(summarizeLoadInputCoverage(input).physicalBoundaryCount).toBe(0);
  });
});
