import { describe, expect, it } from "vitest";
import { DEFAULT_FRICTION_RATE_PER_100FT, DuctSizingError, recommendedMaxVelocityFpm, roundDuctFrictionRate, roundDuctVelocityFpm, sizeDuctForAirflow, sizeRoundDuct, sizeSupplyRoundDuct } from "./round-duct.js";

describe("round duct sizing", () => {
  it("matches the accepted 1000 CFM equal-friction reference", () => {
    const size = sizeRoundDuct({ cfm: 1000 });
    expect(size.targetFrictionRatePer100ft).toBe(DEFAULT_FRICTION_RATE_PER_100FT);
    expect(size.exactDiameterIn).toBeGreaterThan(14); expect(size.exactDiameterIn).toBeLessThan(15);
    expect(size.standardDiameterIn).toBe(15); expect(size.governingConstraint).toBe("friction");
  });
  it("round-trips exact friction and is monotonic", () => {
    const size = sizeRoundDuct({ cfm: 1500, frictionRatePer100ft: 0.1 });
    expect(roundDuctFrictionRate(1500, size.exactDiameterIn)).toBeCloseTo(0.1, 6);
    expect(sizeRoundDuct({ cfm: 4000 }).exactDiameterIn).toBeGreaterThan(sizeRoundDuct({ cfm: 500 }).exactDiameterIn);
  });
  it("uses the velocity cap when it governs", () => {
    const size = sizeRoundDuct({ cfm: 2000, frictionRatePer100ft: 0.5, maxVelocityFpm: 900 });
    expect(size.governingConstraint).toBe("velocity"); expect(size.velocityFpm).toBeLessThanOrEqual(900);
  });
  it("gives a runout a larger supply size than a main", () => {
    const main = sizeSupplyRoundDuct({ cfm: 1200, role: "main" });
    const runout = sizeSupplyRoundDuct({ cfm: 1200, role: "runout" });
    expect(runout.standardDiameterIn).toBeGreaterThan(main.standardDiameterIn);
    expect(runout.velocityFpm).toBeLessThanOrEqual(recommendedMaxVelocityFpm("supply", "runout"));
  });
  it("supports classified supply, return, exhaust, and outside-air caps", () => {
    for (const airflowType of ["supply", "return", "exhaust", "outside-air"] as const) {
      const size = sizeDuctForAirflow({ cfm: 600, airflowType, role: "branch" });
      expect(size.velocityFpm).toBeLessThanOrEqual(recommendedMaxVelocityFpm(airflowType, "branch"));
    }
    expect(() => sizeDuctForAirflow({ cfm: 600, airflowType: "unknown", role: "branch" })).toThrow(expect.objectContaining({ code: "unsupported-airflow-type" }));
    expect(() => recommendedMaxVelocityFpm("supply", "invalid" as never)).toThrow(expect.objectContaining({ code: "unsupported-duct-role" }));
  });
  it("calculates velocity from round area", () => expect(roundDuctVelocityFpm(1000, 12)).toBeCloseTo(1000 / (Math.PI / 4), 3));
  it("fails loudly with a typed error", () => {
    expect(() => sizeRoundDuct({ cfm: 0 })).toThrow(DuctSizingError);
    expect(() => sizeRoundDuct({ cfm: Number.NaN })).toThrow(expect.objectContaining({ code: "invalid-airflow" }));
    expect(() => sizeRoundDuct({ cfm: 100, frictionRatePer100ft: 0 })).toThrow(expect.objectContaining({ code: "invalid-friction-rate" }));
    expect(() => sizeRoundDuct({ cfm: 100, maxVelocityFpm: Number.POSITIVE_INFINITY })).toThrow(expect.objectContaining({ code: "invalid-velocity" }));
    expect(() => roundDuctVelocityFpm(100, 0)).toThrow(expect.objectContaining({ code: "invalid-diameter" }));
    expect(() => sizeRoundDuct({ cfm: 200_000 })).toThrow(expect.objectContaining({ code: "diameter-exceeds-standard-range" }));
  });
});
