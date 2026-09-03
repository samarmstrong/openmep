import { describe, expect, it } from "vitest";

import {
  CLIMATE_ZONES,
  getClimateZone,
  getDesignConditions,
  resolveClimate
} from "./climate";

describe("getClimateZone", () => {
  it("maps Boston, MA (WBDG Office fixture site) to 5A", () => {
    expect(getClimateZone(42.36, -71.06)).toBe("5A");
  });

  it("maps representative coordinates to their own zone", () => {
    expect(getClimateZone(25.76, -80.19)).toBe("1A"); // Miami
    expect(getClimateZone(29.76, -95.37)).toBe("2A"); // Houston
    expect(getClimateZone(33.45, -112.07)).toBe("2B"); // Phoenix
    expect(getClimateZone(47.61, -122.33)).toBe("4C"); // Seattle
    expect(getClimateZone(44.98, -93.27)).toBe("6A"); // Minneapolis
    expect(getClimateZone(64.84, -147.72)).toBe("8"); // Fairbanks
  });

  it("throws on non-finite coordinates", () => {
    expect(() => getClimateZone(Number.NaN, -71)).toThrow(/finite coordinates/);
  });
});

describe("getDesignConditions", () => {
  it("returns a coherent design-condition set for every zone", () => {
    for (const zone of CLIMATE_ZONES) {
      const design = getDesignConditions(zone);
      expect(design.coolingDryBulbF).toBeGreaterThan(design.indoorCoolingSetpointF);
      expect(design.heatingDryBulbF).toBeLessThan(design.indoorHeatingSetpointF);
      expect(design.coolingWetBulbF).toBeLessThanOrEqual(design.coolingDryBulbF);
      expect(design.indoorCoolingSetpointF).toBe(75);
      expect(design.indoorHeatingSetpointF).toBe(70);
    }
  });

  it("uses Boston's cooling design dry-bulb for 5A", () => {
    expect(getDesignConditions("5A").coolingDryBulbF).toBe(89);
  });
});

describe("resolveClimate", () => {
  it("resolves a located site to zone + representative city", () => {
    const resolved = resolveClimate({ latitude: 42.36, longitude: -71.06 });
    expect(resolved).not.toBeNull();
    expect(resolved?.zone).toBe("5A");
    expect(resolved?.representativeCity).toBe("Boston, MA");
    expect(resolved?.design.coolingDryBulbF).toBe(89);
  });

  it("returns null when the site has no coordinates (graceful degradation)", () => {
    expect(resolveClimate({ latitude: null, longitude: null })).toBeNull();
    expect(resolveClimate({ latitude: 42, longitude: null })).toBeNull();
    expect(resolveClimate({ latitude: Number.NaN, longitude: -71 })).toBeNull();
  });
});
