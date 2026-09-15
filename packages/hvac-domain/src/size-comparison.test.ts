import { describe, expect, it } from "vitest";
import { DuctSizingError, sizeSupplyRoundDuct } from "./round-duct.js";
import { compareRoundDuctSize } from "./size-comparison.js";

describe("compareRoundDuctSize", () => {
  const recommended = sizeSupplyRoundDuct({ cfm: 250, role: "main" });
  it("grades the recommended standard diameter as ok", () => {
    const result = compareRoundDuctSize({ actualDiameterIn: recommended.standardDiameterIn, recommended, airflowType: "supply", role: "main" });
    expect(result.status).toBe("ok");
    expect(result.velocityExceeded).toBe(false);
    expect(result.actualVelocityFpm).toBeCloseTo(recommended.velocityFpm, 6);
    expect(result.maxVelocityFpm).toBe(1300);
  });
  it("grades anything below the exact requirement as undersized", () => {
    const result = compareRoundDuctSize({ actualDiameterIn: recommended.exactDiameterIn - 0.5, recommended });
    expect(result.status).toBe("undersized");
    expect(result.actualFrictionRatePer100ft).toBeGreaterThan(recommended.targetFrictionRatePer100ft);
    expect(result.maxVelocityFpm).toBeNull();
  });
  it("tolerates a between-sizes equivalent diameter and flags one full size up as oversized", () => {
    const between = (recommended.exactDiameterIn + recommended.standardDiameterIn) / 2;
    expect(compareRoundDuctSize({ actualDiameterIn: between, recommended }).status).toBe("ok");
    expect(compareRoundDuctSize({ actualDiameterIn: recommended.standardDiameterIn + 1, recommended }).status).toBe("oversized");
  });
  it("reports the velocity cap breach for a tiny duct", () => {
    const result = compareRoundDuctSize({ actualDiameterIn: 4, recommended, airflowType: "supply", role: "runout" });
    expect(result.velocityExceeded).toBe(true);
    expect(result.maxVelocityFpm).toBe(700);
  });
  it("throws a typed error for a non-positive actual diameter", () => {
    expect(() => compareRoundDuctSize({ actualDiameterIn: 0, recommended })).toThrow(DuctSizingError);
  });
});
