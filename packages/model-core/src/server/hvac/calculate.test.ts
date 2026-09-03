import { describe, expect, it } from "vitest";

import type { SpaceSummary } from "../../types";
import { computeStoreyLoads } from "./calculate";
import type { SpaceClassification } from "./classify";

function space(overrides: Partial<SpaceSummary>): SpaceSummary {
  return {
    modelId: "m1",
    sourceId: "architecture",
    discipline: "architecture",
    expressId: 1,
    sourceGlobalId: "g1",
    globalId: "g1",
    compositeGlobalId: "g1",
    name: "Space",
    longName: null,
    storeyGlobalId: "s1",
    area: 200,
    placement: null,
    bounds: null,
    properties: {},
    ...overrides
  };
}

describe("computeStoreyLoads", () => {
  it("emits per-space records and storey totals", () => {
    const classifications = new Map<string, SpaceClassification>([
      [
        "office-1",
        { spaceGlobalId: "office-1", spaceTypeKey: "offices-commercial-general", confidence: "heuristic" }
      ],
      [
        "conf-1",
        { spaceGlobalId: "conf-1", spaceTypeKey: "conference-meeting", confidence: "llm" }
      ]
    ]);

    const result = computeStoreyLoads({
      modelId: "m1",
      planVersion: 1,
      storeyGlobalId: "s1",
      lengthUnit: "foot",
      classifications,
      spaces: [
        space({ globalId: "office-1", name: "Office", area: 200 }),
        space({ globalId: "conf-1", name: "Conference", area: 300 }),
        space({ globalId: "other-storey", name: "Elsewhere", storeyGlobalId: "s2", area: 100 })
      ]
    });

    expect(result.spaces).toHaveLength(2);
    expect(result.totals.spaceCount).toBe(2);

    const office = result.spaces.find((s) => s.spaceGlobalId === "office-1");
    expect(office?.ventilation.vbz).toBeCloseTo(5 * 1 + 0.06 * 200, 4);
    expect(office?.designCfm).toBe(
      Math.max(
        office!.ventilation.voz,
        office!.thermal.cfm,
        office!.estimator.cfm
      )
    );

    expect(result.totals.designCfm).toBeCloseTo(
      result.spaces.reduce((sum, s) => sum + s.designCfm, 0),
      4
    );
  });

  it("converts metre² areas to sqft", () => {
    const classifications = new Map<string, SpaceClassification>([
      [
        "office-1",
        { spaceGlobalId: "office-1", spaceTypeKey: "offices-commercial-general", confidence: "heuristic" }
      ]
    ]);
    const resultFt = computeStoreyLoads({
      modelId: "m1",
      planVersion: 1,
      storeyGlobalId: "s1",
      lengthUnit: "foot",
      classifications,
      spaces: [space({ globalId: "office-1", area: 1076.39 })]
    });
    const resultM = computeStoreyLoads({
      modelId: "m1",
      planVersion: 1,
      storeyGlobalId: "s1",
      lengthUnit: "metre",
      classifications,
      spaces: [space({ globalId: "office-1", area: 100 })]
    });
    expect(resultFt.spaces[0].areaSqft).toBeCloseTo(resultM.spaces[0].areaSqft, 1);
  });

  it("fails loud when a space lacks classification", () => {
    expect(() =>
      computeStoreyLoads({
        modelId: "m1",
        planVersion: 1,
        storeyGlobalId: "s1",
        lengthUnit: "foot",
        classifications: new Map(),
        spaces: [space({ globalId: "office-1" })]
      })
    ).toThrow(/has no ASHRAE classification/);
  });
});
