import { describe, expect, it } from "vitest";

import { computeThermal, DEFAULT_SUPPLY_DELTA_T_F } from "./thermal";

describe("computeThermal — sensible cooling CFM", () => {
  it("sums lighting + equipment watts and people sensible gain", () => {
    const result = computeThermal({
      areaSqft: 500,
      occupants: 10,
      spaceType: {
        lightingWPerSqft: 1,
        equipmentWPerSqft: 0.5,
        peopleSensibleBtuhPerPerson: 250
      }
    });

    const expectedInternalBtuh = 500 * (1 + 0.5) * 3.412;
    const expectedPeopleBtuh = 10 * 250;
    const expectedTotal = expectedInternalBtuh + expectedPeopleBtuh;

    expect(result.sensibleLoadBtuH).toBeCloseTo(expectedTotal, 4);
    expect(result.solarBtuH).toBe(0);
    expect(result.supplyDeltaTF).toBe(DEFAULT_SUPPLY_DELTA_T_F);
    expect(result.cfm).toBeCloseTo(expectedTotal / (1.08 * 20), 4);
  });

  it("adds SHGC-weighted solar gain from oriented glazing", () => {
    const result = computeThermal({
      areaSqft: 500,
      occupants: 0,
      spaceType: {
        lightingWPerSqft: 0,
        equipmentWPerSqft: 0,
        peopleSensibleBtuhPerPerson: 0
      },
      solar: {
        climateZone: "5A",
        glazing: [
          {
            areaSqft: 100,
            orientationDegrees: 90,
            assemblyClass: "fenestration-vertical"
          }
        ]
      }
    });

    expect(result.solarBtuH).toBeCloseTo(100 * 0.38 * 235, 4);
    expect(result.sensibleLoadBtuH).toBeCloseTo(result.solarBtuH, 4);
    expect(result.cfm).toBeCloseTo(result.solarBtuH / (1.08 * 20), 4);
  });

  it("honors a custom supply ΔT", () => {
    const result = computeThermal({
      areaSqft: 100,
      occupants: 0,
      spaceType: {
        lightingWPerSqft: 1,
        equipmentWPerSqft: 0,
        peopleSensibleBtuhPerPerson: 0
      },
      supplyDeltaTF: 25
    });
    expect(result.supplyDeltaTF).toBe(25);
    expect(result.cfm).toBeCloseTo(result.sensibleLoadBtuH / (1.08 * 25), 4);
  });

  it("rejects non-positive ΔT", () => {
    expect(() =>
      computeThermal({
        areaSqft: 100,
        occupants: 0,
        spaceType: {
          lightingWPerSqft: 1,
          equipmentWPerSqft: 0,
          peopleSensibleBtuhPerPerson: 0
        },
        supplyDeltaTF: 0
      })
    ).toThrow();
  });
});
