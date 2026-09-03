import { describe, expect, it } from "vitest";

import {
  classifyAirflowTypeFromProperties,
  classifySystemDomain,
  resolveElementAirflowType
} from "./airflow";

const supplySystem = {
  systemGlobalId: "sys-1",
  name: "SA-1",
  description: "Supply air",
  airflowType: "supply" as const
};

describe("classifyAirflowTypeFromProperties", () => {
  it("reads Revit MEP 2011 'System Type' labels from any property set", () => {
    expect(
      classifyAirflowTypeFromProperties({
        PSet_Revit_Mechanical: { "System Type": "Return Air", "System Name": "Mechanical Return Air 1" }
      })
    ).toBe("return");
  });

  it("ignores non-air systems in multi-valued labels", () => {
    expect(
      classifyAirflowTypeFromProperties({
        PSet_Revit_Mechanical: { "System Type": "Hydronic Supply,Exhaust Air,Power" }
      })
    ).toBe("exhaust");
  });

  it("returns unknown when air systems disagree or are absent", () => {
    expect(
      classifyAirflowTypeFromProperties({
        PSet_Revit_Mechanical: { "System Type": "Supply Air,Return Air" }
      })
    ).toBe("unknown");
    expect(
      classifyAirflowTypeFromProperties({
        PSet_Revit_Mechanical: { "System Type": "Hydronic Supply" }
      })
    ).toBe("unknown");
    expect(classifyAirflowTypeFromProperties({})).toBe("unknown");
  });
});

describe("resolveElementAirflowType", () => {
  it("prefers IfcSystem group assignments over element properties", () => {
    expect(
      resolveElementAirflowType({
        systemAssignments: [supplySystem],
        properties: { PSet_Revit_Mechanical: { "System Type": "Return Air" } },
        name: "M_Return Diffuser",
        objectType: null
      })
    ).toBe("supply");
  });

  it("falls through properties to the element name", () => {
    expect(
      resolveElementAirflowType({
        systemAssignments: [],
        properties: { PSet_Revit_Mechanical: { "System Type": "Return Air" } },
        name: "M_Supply Diffuser",
        objectType: null
      })
    ).toBe("return");
    expect(
      resolveElementAirflowType({
        systemAssignments: [],
        properties: {},
        name: "M_Supply Diffuser:600 x 600 Face:562239",
        objectType: null
      })
    ).toBe("supply");
    expect(
      resolveElementAirflowType({
        systemAssignments: [],
        properties: {},
        name: "Rectangular Duct:Mitered Elbows / Taps:576187",
        objectType: null
      })
    ).toBe("unknown");
  });
});

describe("classifySystemDomain", () => {
  it("treats any air label as air even alongside electrical property sets", () => {
    expect(
      classifySystemDomain({
        PSet_Revit_Mechanical: { "System Type": "Supply Air" },
        "PSet_Revit_Electrical - Loads": { Panel: "LP-1" }
      })
    ).toBe("air");
  });

  it("marks declared non-air systems and domain property sets as non-air", () => {
    expect(classifySystemDomain({ PSet_Revit_Mechanical: { "System Type": "Fire Protection Wet" } })).toBe("non-air");
    expect(classifySystemDomain({ PSet_Revit_Mechanical: { "System Type": "Domestic Cold Water,Sanitary" } })).toBe("non-air");
    expect(classifySystemDomain({ "PSet_Revit_Electrical - Circuiting": { "Electrical Data": "120 V" } })).toBe("non-air");
  });

  it("returns unknown without system evidence or with unspecified labels", () => {
    expect(classifySystemDomain({})).toBe("unknown");
    expect(classifySystemDomain({ PSet_Revit_Mechanical: { "System Type": "Undefined" } })).toBe("unknown");
    expect(classifySystemDomain({ PSet_Revit_Constraints: { Level: "Level 1" } })).toBe("unknown");
  });
});
