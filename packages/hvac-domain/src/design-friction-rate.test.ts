import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DuctNetworkError, recommendDuctSegments, type NetworkItem } from "./duct-network.js";
import { readNetworkDocument, sizeNetworkDocument, sizeNetworkInput } from "./cli.js";
import { STANDARD_ROUND_DIAMETERS_IN } from "./round-duct.js";
import { openmep } from "./scripting.js";

const worksheet = () => readNetworkDocument(readFileSync(new URL("../examples/acca-manual-d-worksheet.network.json", import.meta.url), "utf8"));
const stepsBetween = (a: number, b: number): number => Math.abs(STANDARD_ROUND_DIAMETERS_IN.indexOf(a as never) - STANDARD_ROUND_DIAMETERS_IN.indexOf(b as never));

describe("available-static-pressure (Manual D) friction rate", () => {
  it("reproduces the ACCA worksheet: ASP 0.20, TEL 200 ft, FR 0.10", () => {
    const result = sizeNetworkDocument(worksheet());
    expect(result.design).toMatchObject({ externalStaticInWg: 0.7, componentLossesInWg: 0.5, availableStaticInWg: 0.2, totalEffectiveLengthFt: 200, frictionRatePer100ft: 0.1 });
    expect(result.summary.frictionRatePer100ft).toBe(0.1);
    const paths = Object.fromEntries(result.design!.paths.map((path) => [path.airflowType, path]));
    expect(paths.supply).toMatchObject({ terminalItemId: "reg-bed3", measuredLengthFt: 65, equivalentLengthFt: 55, effectiveLengthFt: 120, itemRefs: ["reg-bed3", "run-bed3", "supply-tee", "supply-trunk"] });
    expect(paths.return).toMatchObject({ terminalItemId: "grille-bed1", effectiveLengthFt: 80 });
    expect(result.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });
  it("lands within one standard size of the worksheet's branch selections (brochure sizes are flex; ours are galvanized round)", () => {
    const result = sizeNetworkDocument(worksheet());
    const byRef = Object.fromEntries(result.segments.map((segment) => [segment.elementRef, segment.recommended.standardDiameterIn]));
    const brochure: Record<string, number> = { "run-bed1": 8, "run-closet": 4, "run-bed2-1": 6, "run-bed3": 7, "run-living-1": 8, "run-den": 8, "run-dining-1": 6, "run-foyer": 6, "run-kitchen-1": 6, "run-bath1": 6, "run-bath2": 5 };
    for (const [ref, flexIn] of Object.entries(brochure)) {
      expect(byRef[ref], ref).toBeDefined();
      expect(stepsBetween(byRef[ref]!, flexIn), `${ref}: ours ${byRef[ref]} vs brochure ${flexIn}`).toBeLessThanOrEqual(1);
      expect(byRef[ref]!, `${ref} should not exceed the flex selection`).toBeLessThanOrEqual(flexIn);
    }
    expect(byRef["run-foyer"]).toBe(6);
    expect(byRef["run-bath2"]).toBe(5);
  });
  it("uses the fixed default rate and reports design null without fan", () => {
    const { items } = worksheet();
    const fixed = sizeNetworkInput(items);
    expect(fixed.design).toBeNull();
    expect(fixed.summary.frictionRatePer100ft).toBe(0.08);
    const derived = sizeNetworkInput(items, { fan: { externalStaticInWg: 0.7, componentLossesInWg: { all: 0.5 } } });
    expect(derived.design?.frictionRatePer100ft).toBe(0.1);
    // 0.10 > 0.08, so derived sizes are never larger than fixed-rate sizes.
    for (const segment of derived.segments) {
      const fixedSize = fixed.segments.find((other) => other.elementRef === segment.elementRef)!.recommended.standardDiameterIn;
      expect(segment.recommended.standardDiameterIn).toBeLessThanOrEqual(fixedSize);
    }
  });
  it("flags friction rates outside the 0.06–0.18 range as warnings", () => {
    const { items } = worksheet();
    const low = sizeNetworkInput(items, { fan: { externalStaticInWg: 0.5, componentLossesInWg: { coil: 0.4 } } });
    expect(low.design?.frictionRatePer100ft).toBe(0.05);
    expect(low.findings).toContainEqual(expect.objectContaining({ code: "friction-rate-out-of-range", severity: "warning" }));
    const high = sizeNetworkInput(items, { fan: { externalStaticInWg: 0.8 } });
    expect(high.design?.frictionRatePer100ft).toBe(0.4);
    expect(high.findings.find((finding) => finding.code === "friction-rate-out-of-range")?.message).toMatch(/above/);
  });
  it("warns once per fitting without an equivalent length and throws typed errors for missing lengths and no available static", () => {
    const base: NetworkItem[] = [
      { id: "eq", elementRef: "eq", kind: "equipment", airflowType: "unknown", connectedItemRefs: [] },
      { id: "main", elementRef: "main", kind: "segment", airflowType: "supply", connectedItemRefs: ["eq", "tee"], lengthFt: 10 },
      { id: "tee", elementRef: "tee", kind: "fitting", airflowType: "supply", connectedItemRefs: [] },
      { id: "r1", elementRef: "r1", kind: "segment", airflowType: "supply", connectedItemRefs: ["tee", "t1"], lengthFt: 20 },
      { id: "t1", elementRef: "t1", kind: "terminal", airflowType: "supply", connectedItemRefs: [], requiredCfm: 100 },
      { id: "r2", elementRef: "r2", kind: "segment", airflowType: "supply", connectedItemRefs: ["tee", "t2"], lengthFt: 30 },
      { id: "t2", elementRef: "t2", kind: "terminal", airflowType: "supply", connectedItemRefs: [], requiredCfm: 100 },
    ];
    const result = recommendDuctSegments(base, { fan: { externalStaticInWg: 0.5, componentLossesInWg: { filter: 0.1 } } });
    expect(result.findings.filter((finding) => finding.code === "missing-equivalent-length")).toHaveLength(1);
    expect(result.design).toMatchObject({ totalEffectiveLengthFt: 40, frictionRatePer100ft: 1 });
    const unmeasured = base.map((item) => (item.elementRef === "r2" ? { ...item, lengthFt: undefined } : item));
    expect(() => recommendDuctSegments(unmeasured, { fan: { externalStaticInWg: 0.5 } })).toThrow(expect.objectContaining({ code: "missing-length", elementRef: "r2" }));
    expect(() => recommendDuctSegments(base, { fan: { externalStaticInWg: 0.5, componentLossesInWg: { coil: 0.3, filter: 0.2 } } })).toThrow(expect.objectContaining({ code: "non-positive-available-static" }));
    expect(() => recommendDuctSegments(base, { fan: { externalStaticInWg: -1 } })).toThrow(DuctNetworkError);
  });
  it("is reachable from the scripting namespace", () => {
    const result = openmep.sizeNetwork(JSON.parse(readFileSync(new URL("../examples/acca-manual-d-worksheet.network.json", import.meta.url), "utf8")));
    expect(result.design?.frictionRatePer100ft).toBe(0.1);
    expect(openmep.frictionRateFromStatic({ externalStaticInWg: 0.7, componentLossesInWg: { all: 0.5 }, totalEffectiveLengthFt: 200 })).toEqual({ availableStaticInWg: 0.2, frictionRatePer100ft: 0.1, inRange: true });
    expect(openmep.parseNetworkDocument({ items: [], fan: { externalStaticInWg: 0.5 } }).fan).toEqual({ externalStaticInWg: 0.5 });
    expect(() => openmep.parseNetworkDocument({ items: [], fan: { externalStaticInWg: 0 } })).toThrow(/fan.externalStaticInWg/);
  });
});
