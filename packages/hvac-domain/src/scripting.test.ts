import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applySizes, isEngineError, openmep, OPENMEP_VERSION } from "./scripting.js";

const example = () => JSON.parse(readFileSync(new URL("../examples/furnace-two-registers.items.json", import.meta.url), "utf8")) as unknown;

describe("openmep scripting namespace", () => {
  it("matches the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(OPENMEP_VERSION).toBe(pkg.version);
    expect(openmep.version).toBe(pkg.version);
  });

  it("sizes and grades one duct", () => {
    expect(openmep.sizeDuct({ cfm: 150, role: "runout" }).recommended.standardDiameterIn).toBe(8);
    const graded = openmep.gradeDuct({ cfm: 150, role: "runout", existing: { shape: "round", diameterIn: 6 } });
    expect(graded.existing.comparison.status).toBe("undersized");
    const rect = openmep.gradeDuct({ cfm: 400, airflowType: "return", existing: { shape: "rect", widthIn: 14, heightIn: 8 } });
    expect(rect.existing.equivalentDiameterIn).toBeCloseTo(openmep.equivalentDiameterIn({ shape: "rect", widthIn: 14, heightIn: 8 }));
  });

  it("sizes a network document from raw JSON and applies the sizes back", () => {
    const result = openmep.sizeNetwork(example());
    expect(result.summary.sizedSegments).toBeGreaterThan(0);
    const items = openmep.parseNetwork(example());
    const patched = applySizes(items, result);
    const sized = patched.filter((item) => item.kind === "segment" && item.existing !== undefined);
    expect(sized).toHaveLength(result.summary.sizedSegments);
    const regraded = openmep.sizeNetwork(patched);
    expect(regraded.findings.filter((finding) => finding.code === "undersized" || finding.code === "oversized")).toEqual([]);
    expect(regraded.segments.every((segment) => segment.existing?.comparison.status === "ok")).toBe(true);
  });

  it("connects coincident ports and exposes constants", () => {
    const refs = openmep.connectPorts([
      { itemRef: "a", position: [0, 0, 0] },
      { itemRef: "b", position: [0.01, 0, 0] },
      { itemRef: "c", position: [5, 0, 0] },
    ]);
    expect(refs.get("a")).toEqual(["b"]);
    expect(refs.get("c")).toEqual([]);
    expect(openmep.constants.frictionRatePer100ft).toBe(0.08);
    expect(openmep.maxVelocityFpm("supply", "runout")).toBe(openmep.maxVelocityFpm("supply", "runout"));
    expect(openmep.velocityFpm(100, 6)).toBeCloseTo(509.3, 0);
  });

  it("raises typed engine errors recognised by isEngineError", () => {
    try {
      openmep.sizeNetwork([{ id: "t", elementRef: "t", kind: "terminal", requiredCfm: "x" }]);
      expect.unreachable();
    } catch (error) {
      expect(isEngineError(error)).toBe(true);
      expect(error).toBeInstanceOf(openmep.errors.NetworkInputError);
    }
    expect(() => openmep.sizeDuct({ cfm: -1 })).toThrow(openmep.errors.DuctSizingError);
    expect(isEngineError(new Error("plain"))).toBe(false);
  });
});
