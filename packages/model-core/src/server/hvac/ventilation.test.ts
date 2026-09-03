import { describe, expect, it } from "vitest";

import { getSpaceType } from "./space-types";
import {
  computeVentilation,
  defaultOccupants,
  DEFAULT_ZONE_AIR_DISTRIBUTION_EFFECTIVENESS
} from "./ventilation";

describe("computeVentilation — ASHRAE 62.1 Ventilation Rate Procedure", () => {
  it("matches the canonical 200 sqft / 1-person office example", () => {
    const office = getSpaceType("offices-commercial-general");
    expect(office.ra).toBe(0.06);
    expect(office.rp).toBe(5);

    const result = computeVentilation({
      areaSqft: 200,
      occupants: 1,
      spaceType: office
    });

    expect(result.vbz).toBe(5 * 1 + 0.06 * 200);
    expect(result.vbz).toBe(17);
    expect(result.ez).toBe(DEFAULT_ZONE_AIR_DISTRIBUTION_EFFECTIVENESS);
    expect(result.voz).toBeCloseTo(17 / 0.8, 6);
  });

  it("uses the provided Ez override", () => {
    const conference = getSpaceType("conference-meeting");
    const result = computeVentilation({
      areaSqft: 500,
      occupants: 25,
      spaceType: conference,
      ez: 1
    });
    expect(result.ez).toBe(1);
    expect(result.voz).toBe(result.vbz);
  });

  it("rejects invalid Ez", () => {
    const office = getSpaceType("offices-commercial-general");
    expect(() =>
      computeVentilation({ areaSqft: 100, occupants: 1, spaceType: office, ez: 0 })
    ).toThrow();
  });
});

describe("defaultOccupants", () => {
  it("rounds up to the nearest whole person", () => {
    expect(defaultOccupants(500, 50)).toBe(25);
    expect(defaultOccupants(100, 5)).toBe(1);
    expect(defaultOccupants(10, 5)).toBe(1);
  });

  it("returns 0 for zero area or density", () => {
    expect(defaultOccupants(0, 50)).toBe(0);
    expect(defaultOccupants(100, 0)).toBe(0);
  });
});
