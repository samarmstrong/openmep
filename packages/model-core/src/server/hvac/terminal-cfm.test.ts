import { describe, expect, it } from "vitest";

import { assignTerminalCfm } from "./terminal-cfm";
import type { MechanicalEditItem, PlanSpace, SpaceLoad } from "../../types";

function space(globalId: string, outer: Array<[number, number]>): PlanSpace {
  return { globalId, polygons: [{ outer, holes: [] }] } as unknown as PlanSpace;
}

function terminal(
  id: string,
  position: [number, number],
  airflowType: "supply" | "return" = "supply"
): MechanicalEditItem {
  return {
    id,
    visualRef: `${id}:v`,
    elementRef: id,
    editKind: "node",
    kind: "mech-terminal",
    position,
    size: [1, 1],
    rotation: 0,
    airflowType,
    connectedItemIds: [],
    spaceGlobalId: null,
    spaceDesignCfm: null,
    requiredCfm: null
  } as MechanicalEditItem;
}

function load(spaceGlobalId: string, designCfm: number): SpaceLoad {
  return { spaceGlobalId, designCfm } as unknown as SpaceLoad;
}

const SQUARE: Array<[number, number]> = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10]
];

describe("assignTerminalCfm", () => {
  it("splits a space's design CFM equally across its supply terminals", () => {
    const result = assignTerminalCfm(
      [terminal("t1", [2, 2]), terminal("t2", [8, 8])],
      [space("A", SQUARE)],
      [load("A", 800)]
    );
    const nodes = result.editItems.filter(
      (i): i is Extract<MechanicalEditItem, { editKind: "node" }> =>
        i.editKind === "node"
    );
    expect(result.assignedSupplyTerminals).toBe(2);
    for (const n of nodes) {
      expect(n.spaceGlobalId).toBe("A");
      expect(n.spaceDesignCfm).toBe(800);
      expect(n.requiredCfm).toBe(400);
    }
  });

  it("leaves terminals outside every space unassigned and flags them", () => {
    const result = assignTerminalCfm(
      [terminal("t1", [50, 50])],
      [space("A", SQUARE)],
      [load("A", 800)]
    );
    const node = result.editItems[0] as Extract<
      MechanicalEditItem,
      { editKind: "node" }
    >;
    expect(node.spaceGlobalId).toBeNull();
    expect(node.requiredCfm).toBeNull();
    expect(result.unassignedSupplyTerminals).toBe(1);
    expect(result.diagnostics.join(" ")).toMatch(/outside every classified space/);
  });

  it("flags spaces that need supply CFM but have no supply terminal", () => {
    const result = assignTerminalCfm([], [space("A", SQUARE)], [load("A", 1200)]);
    expect(result.spacesNeedingSupplyWithNoTerminal).toBe(1);
    expect(result.diagnostics.join(" ")).toMatch(/have no supply terminal/);
  });

  it("does not touch non-supply terminals", () => {
    const result = assignTerminalCfm(
      [terminal("t1", [2, 2], "return")],
      [space("A", SQUARE)],
      [load("A", 800)]
    );
    const node = result.editItems[0] as Extract<
      MechanicalEditItem,
      { editKind: "node" }
    >;
    expect(node.spaceGlobalId).toBeNull();
    expect(node.requiredCfm).toBeNull();
    expect(result.assignedSupplyTerminals).toBe(0);
  });

  it("assigns to the smallest containing space when rooms nest", () => {
    const big = space("BIG", [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20]
    ]);
    const small = space("SMALL", [
      [5, 5],
      [10, 5],
      [10, 10],
      [5, 10]
    ]);
    const result = assignTerminalCfm(
      [terminal("t1", [7, 7])],
      [big, small],
      [load("BIG", 1000), load("SMALL", 300)]
    );
    const node = result.editItems[0] as Extract<
      MechanicalEditItem,
      { editKind: "node" }
    >;
    expect(node.spaceGlobalId).toBe("SMALL");
    expect(node.requiredCfm).toBe(300);
  });
});
