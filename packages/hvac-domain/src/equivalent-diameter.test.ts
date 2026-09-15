import { describe, expect, it } from "vitest";
import { flatOvalEquivalentDiameterIn, rectangularEquivalentDiameterIn } from "./equivalent-diameter.js";
import { DuctSizingError } from "./round-duct.js";

describe("equivalent diameters", () => {
  it("matches the ASHRAE rectangular equivalent table within rounding", () => {
    // ASHRAE Fundamentals, Duct Design, circular equivalents of rectangular ducts.
    expect(Math.abs(rectangularEquivalentDiameterIn(12, 12) - 13.1)).toBeLessThan(0.1);
    expect(Math.abs(rectangularEquivalentDiameterIn(14, 8) - 11.5)).toBeLessThan(0.1);
    expect(Math.abs(rectangularEquivalentDiameterIn(20, 10) - 15.2)).toBeLessThan(0.1);
    expect(rectangularEquivalentDiameterIn(8, 14)).toBe(rectangularEquivalentDiameterIn(14, 8));
  });
  it("reduces a flat oval to the round case when both axes match", () => {
    // A = π b²/4, P = π b → De = 1.55 (π/4)^0.625 b^1.25 / (π b)^0.25 ≈ 1.0 b.
    expect(flatOvalEquivalentDiameterIn(10, 10)).toBeCloseTo(10, 0);
    expect(flatOvalEquivalentDiameterIn(18, 8)).toBe(flatOvalEquivalentDiameterIn(8, 18));
    expect(flatOvalEquivalentDiameterIn(18, 8)).toBeGreaterThan(8);
    expect(flatOvalEquivalentDiameterIn(18, 8)).toBeLessThan(rectangularEquivalentDiameterIn(18, 8));
  });
  it("throws typed errors for non-positive dimensions", () => {
    expect(() => rectangularEquivalentDiameterIn(0, 8)).toThrow(DuctSizingError);
    expect(() => flatOvalEquivalentDiameterIn(8, Number.NaN)).toThrow(expect.objectContaining({ code: "invalid-diameter" }));
  });
});
