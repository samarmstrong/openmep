import { describe, expect, it } from "vitest";

import type { ElementSummary } from "../../types";
import { classifyAssembly, getAssemblyDefaults } from "./assemblies";

function element(overrides: Partial<ElementSummary>): ElementSummary {
  return {
    modelId: "m1",
    sourceId: "architecture",
    discipline: "architecture",
    expressId: 1,
    sourceGlobalId: "g1",
    globalId: "g1",
    compositeGlobalId: "g1",
    ifcClass: "IFCWALL",
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
    properties: {},
    ...overrides
  };
}

describe("getAssemblyDefaults", () => {
  it("returns the 90.1 code-minimum steel-frame wall U-factor for 5A", () => {
    expect(getAssemblyDefaults("wall-steel-frame", "5A").uValueBtuHrFt2F).toBe(0.064);
  });

  it("tightens U-factors as climate gets colder", () => {
    const z3 = getAssemblyDefaults("roof-above-deck", "3A").uValueBtuHrFt2F;
    const z5 = getAssemblyDefaults("roof-above-deck", "5A").uValueBtuHrFt2F;
    const z8 = getAssemblyDefaults("roof-above-deck", "8").uValueBtuHrFt2F;
    expect(z3).toBeGreaterThanOrEqual(z5);
    expect(z5).toBeGreaterThanOrEqual(z8);
  });

  it("returns an SHGC for fenestration but not for opaque assemblies", () => {
    expect(getAssemblyDefaults("fenestration-vertical", "5A").shgc).toBeGreaterThan(0);
    expect(getAssemblyDefaults("wall-mass", "5A").shgc).toBeUndefined();
  });

  it("uses the moisture-suffix zone's numeric band (7 differs from 3B)", () => {
    expect(getAssemblyDefaults("wall-steel-frame", "3B").uValueBtuHrFt2F).toBe(0.084);
    expect(getAssemblyDefaults("wall-steel-frame", "7").uValueBtuHrFt2F).toBe(0.052);
  });
});

describe("classifyAssembly", () => {
  it("classifies a plain wall as steel-frame by default", () => {
    expect(classifyAssembly(element({ ifcClass: "IFCWALL", name: "Basic Wall" }))).toBe(
      "wall-steel-frame"
    );
  });

  it("recognizes masonry and curtain walls from the name", () => {
    expect(classifyAssembly(element({ name: "8\" CMU Wall" }))).toBe("wall-mass");
    expect(classifyAssembly(element({ name: "Storefront Curtain Wall" }))).toBe(
      "fenestration-vertical"
    );
  });

  it("classifies windows, curtain walls, and doors", () => {
    expect(classifyAssembly(element({ ifcClass: "IFCWINDOW", name: "Fixed" }))).toBe(
      "fenestration-vertical"
    );
    expect(classifyAssembly(element({ ifcClass: "IFCWINDOW", name: "Skylight" }))).toBe(
      "fenestration-skylight"
    );
    expect(classifyAssembly(element({ ifcClass: "IFCCURTAINWALL" }))).toBe(
      "fenestration-vertical"
    );
    expect(classifyAssembly(element({ ifcClass: "IFCDOOR", name: "Hollow Metal" }))).toBe(
      "door-opaque"
    );
    expect(classifyAssembly(element({ ifcClass: "IFCDOOR", name: "Aluminum Glass" }))).toBe(
      "door-glass"
    );
  });

  it("splits slabs into roof vs. ground using boundary exposure", () => {
    const slab = element({ ifcClass: "IFCSLAB", name: "Floor" });
    expect(classifyAssembly(slab, "external-earth")).toBe("slab-on-grade-unheated");
    expect(classifyAssembly(slab, "external")).toBe("roof-above-deck");
    expect(classifyAssembly(element({ ifcClass: "IFCSLAB", name: "Roof Deck" }))).toBe(
      "roof-above-deck"
    );
  });

  it("returns null for non-envelope element classes", () => {
    expect(classifyAssembly(element({ ifcClass: "IFCCOLUMN" }))).toBeNull();
    expect(classifyAssembly(element({ ifcClass: "IFCBEAM" }))).toBeNull();
    expect(classifyAssembly(element({ ifcClass: "IFCBUILDINGELEMENTPROXY" }))).toBeNull();
  });
});
