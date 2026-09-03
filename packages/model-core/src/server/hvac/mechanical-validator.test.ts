import { describe, expect, it } from "vitest";

import { validateMechanicalPlan } from "./mechanical-validator";
import { recommendDuctSegmentSizes } from "./duct-network";
import type { MechanicalEditItem, PlanSpace, SpaceLoad } from "../../types";

const SQUARE: Array<[number, number]> = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

function space(globalId: string, outer = SQUARE): PlanSpace {
  return { globalId, polygons: [{ outer, holes: [] }] } as unknown as PlanSpace;
}

function load(spaceGlobalId: string, designCfm: number): SpaceLoad {
  return { spaceGlobalId, designCfm } as unknown as SpaceLoad;
}

function supplyTerminal(opts: {
  id: string;
  elementRef?: string;
  position: [number, number];
  spaceGlobalId: string | null;
  requiredCfm: number | null;
  connectedItemIds?: string[];
}): MechanicalEditItem {
  return {
    id: opts.id,
    visualRef: `${opts.id}:v`,
    elementRef: opts.elementRef ?? opts.id,
    editKind: "node",
    kind: "mech-terminal",
    position: opts.position,
    size: [1, 1],
    rotation: 0,
    airflowType: "supply",
    connectedItemIds: opts.connectedItemIds ?? [],
    spaceGlobalId: opts.spaceGlobalId,
    spaceDesignCfm: null,
    requiredCfm: opts.requiredCfm,
  } as MechanicalEditItem;
}

function equipment(
  elementRef: string,
  connectedItemIds: string[] = [],
): MechanicalEditItem {
  return {
    id: `${elementRef}:edit`,
    visualRef: `${elementRef}:v`,
    elementRef,
    editKind: "node",
    kind: "mech-equipment",
    position: [0, 0],
    size: [1, 1],
    rotation: 0,
    airflowType: "supply",
    connectedItemIds,
    spaceGlobalId: null,
    spaceDesignCfm: null,
    requiredCfm: null,
  } as MechanicalEditItem;
}

function segment(
  elementRef: string,
  connectedItemIds: string[],
): MechanicalEditItem {
  return {
    id: `${elementRef}:edit`,
    visualRef: `${elementRef}:v`,
    elementRef,
    editKind: "edge",
    kind: "mech-segment",
    path: [
      [0, 0],
      [1, 1],
    ],
    width: 1,
    airflowType: "supply",
    connectedItemIds,
  } as MechanicalEditItem;
}

describe("validateMechanicalPlan", () => {
  it("passes when each room's diffusers deliver its design CFM", () => {
    const report = validateMechanicalPlan({
      editItems: [
        supplyTerminal({
          id: "t1",
          position: [2, 2],
          spaceGlobalId: "A",
          requiredCfm: 400,
        }),
        supplyTerminal({
          id: "t2",
          position: [8, 8],
          spaceGlobalId: "A",
          requiredCfm: 400,
        }),
      ],
      spaces: [space("A")],
      spaceLoads: [load("A", 800)],
    });
    expect(
      report.findings.filter((f) => f.check === "cfm-conservation"),
    ).toHaveLength(0);
  });

  it("flags an undersupplied room", () => {
    const report = validateMechanicalPlan({
      editItems: [
        supplyTerminal({
          id: "t1",
          position: [2, 2],
          spaceGlobalId: "A",
          requiredCfm: 400,
        }),
      ],
      spaces: [space("A")],
      spaceLoads: [load("A", 800)],
    });
    expect(report.passed).toBe(false);
    expect(
      report.findings.some(
        (f) => f.check === "cfm-conservation" && f.spaceGlobalId === "A",
      ),
    ).toBe(true);
  });

  it("flags a room with load but no supply terminal", () => {
    const report = validateMechanicalPlan({
      editItems: [],
      spaces: [space("A")],
      spaceLoads: [load("A", 1200)],
    });
    expect(
      report.findings.some((f) =>
        /no supply terminal delivers it/.test(f.message),
      ),
    ).toBe(true);
  });

  it("flags a terminal whose declared room does not contain it", () => {
    const report = validateMechanicalPlan({
      editItems: [
        supplyTerminal({
          id: "t1",
          position: [50, 50],
          spaceGlobalId: "A",
          requiredCfm: 800,
        }),
      ],
      spaces: [space("A")],
      spaceLoads: [load("A", 800)],
    });
    expect(
      report.findings.some(
        (f) => f.check === "terminal-in-room" && f.itemId === "t1",
      ),
    ).toBe(true);
  });

  it("warns when a supply terminal cannot reach equipment, passes when it can", () => {
    const connected = validateMechanicalPlan({
      editItems: [
        equipment("EQ", ["SEG"]),
        segment("SEG", ["EQ", "TERM"]),
        supplyTerminal({
          id: "t1",
          elementRef: "TERM",
          position: [2, 2],
          spaceGlobalId: "A",
          requiredCfm: 800,
          connectedItemIds: ["SEG"],
        }),
      ],
      spaces: [space("A")],
      spaceLoads: [load("A", 800)],
    });
    expect(
      connected.findings.filter((f) => f.check === "connectivity"),
    ).toHaveLength(0);

    const orphan = validateMechanicalPlan({
      editItems: [
        supplyTerminal({
          id: "t1",
          position: [2, 2],
          spaceGlobalId: "A",
          requiredCfm: 800,
        }),
      ],
      spaces: [space("A")],
      spaceLoads: [load("A", 800)],
    });
    expect(
      orphan.findings.some(
        (f) => f.check === "connectivity" && f.severity === "warning",
      ),
    ).toBe(true);
  });
});

describe("targeted sizing and balance checks", () => {
  it("checks a target duct width against propagated CFM", () => {
    const items = [
      equipment("EQ", ["SEG"]),
      segment("SEG", ["EQ", "TERM"]),
      supplyTerminal({
        id: "TERM:edit",
        elementRef: "TERM",
        position: [2, 2],
        spaceGlobalId: "A",
        requiredCfm: 400,
        connectedItemIds: ["SEG"],
      }),
    ];
    const wrong = validateMechanicalPlan({
      editItems: items,
      spaces: [space("A")],
      spaceLoads: [load("A", 400)],
      options: { ductSizingItemIds: ["SEG:edit"] },
    });
    expect(wrong.findings).toContainEqual(
      expect.objectContaining({ check: "duct-sizing", itemId: "SEG:edit" }),
    );

    const recommendedWidthFt = recommendDuctSegmentSizes(items).segments.get(
      "SEG:edit",
    )!.recommendedWidthFt;
    const corrected = validateMechanicalPlan({
      editItems: items.map((item) =>
        item.id === "SEG:edit" ? { ...item, width: recommendedWidthFt } : item,
      ) as MechanicalEditItem[],
      spaces: [space("A")],
      spaceLoads: [load("A", 400)],
      options: { ductSizingItemIds: ["SEG:edit"] },
    });
    expect(
      corrected.findings.filter((finding) => finding.check === "duct-sizing"),
    ).toEqual([]);
  });

  it("requires a targeted room's terminals to split design CFM equally", () => {
    const report = validateMechanicalPlan({
      editItems: [
        supplyTerminal({
          id: "t1",
          position: [2, 2],
          spaceGlobalId: "A",
          requiredCfm: 300,
        }),
        supplyTerminal({
          id: "t2",
          position: [8, 8],
          spaceGlobalId: "A",
          requiredCfm: 500,
        }),
      ],
      spaces: [space("A")],
      spaceLoads: [load("A", 800)],
      options: { terminalBalanceSpaceIds: ["A"] },
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        check: "terminal-cfm-balance",
        spaceGlobalId: "A",
      }),
    );
  });
});
