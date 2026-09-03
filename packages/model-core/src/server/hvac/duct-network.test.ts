import { describe, expect, it } from "vitest";

import type { MechanicalEditItem } from "../../types";
import { DuctNetworkError, recommendDuctSegmentSizes } from "./duct-network";

function node(input: {
  ref: string;
  kind: "mech-terminal" | "mech-fitting" | "mech-equipment";
  connected: string[];
  cfm?: number;
}): MechanicalEditItem {
  return {
    id: `${input.ref}:edit`,
    visualRef: `${input.ref}:visual`,
    elementRef: input.ref,
    editKind: "node",
    kind: input.kind,
    position: [0, 0],
    size: [1, 1],
    rotation: 0,
    airflowType: "supply",
    connectedItemIds: input.connected,
    spaceGlobalId: input.kind === "mech-terminal" ? "SPACE" : null,
    spaceDesignCfm: input.kind === "mech-terminal" ? (input.cfm ?? null) : null,
    requiredCfm: input.kind === "mech-terminal" ? (input.cfm ?? null) : null,
  } as MechanicalEditItem;
}

function edge(ref: string, connected: string[]): MechanicalEditItem {
  return {
    id: `${ref}:edit`,
    visualRef: `${ref}:visual`,
    elementRef: ref,
    editKind: "edge",
    kind: "mech-segment",
    path: [
      [0, 0],
      [1, 0],
    ],
    width: 0.5,
    airflowType: "supply",
    connectedItemIds: connected,
  } as MechanicalEditItem;
}

describe("recommendDuctSegmentSizes", () => {
  it("accumulates terminal CFM from runouts through a branch and main", () => {
    const result = recommendDuctSegmentSizes([
      node({ ref: "EQ", kind: "mech-equipment", connected: ["MAIN"] }),
      edge("MAIN", ["EQ", "FIT"]),
      node({
        ref: "FIT",
        kind: "mech-fitting",
        connected: ["MAIN", "R1", "R2"],
      }),
      edge("R1", ["FIT", "T1"]),
      node({ ref: "T1", kind: "mech-terminal", connected: ["R1"], cfm: 300 }),
      edge("R2", ["FIT", "T2"]),
      node({ ref: "T2", kind: "mech-terminal", connected: ["R2"], cfm: 200 }),
    ]);

    expect(result.findings).toEqual([]);
    expect(result.segments.get("R1:edit")).toMatchObject({
      cfm: 300,
      role: "runout",
    });
    expect(result.segments.get("R2:edit")).toMatchObject({
      cfm: 200,
      role: "runout",
    });
    expect(result.segments.get("MAIN:edit")).toMatchObject({
      cfm: 500,
      role: "main",
      terminalItemIds: ["T1:edit", "T2:edit"],
    });
  });

  it("uses one deterministic shortest path through a cyclic graph", () => {
    const result = recommendDuctSegmentSizes([
      node({ ref: "EQ", kind: "mech-equipment", connected: ["A", "B"] }),
      edge("A", ["EQ", "FIT"]),
      edge("B", ["EQ", "FIT"]),
      node({ ref: "FIT", kind: "mech-fitting", connected: ["A", "B", "RUN"] }),
      edge("RUN", ["FIT", "T"]),
      node({ ref: "T", kind: "mech-terminal", connected: ["RUN"], cfm: 250 }),
    ]);

    expect(result.segments.get("A:edit")?.cfm).toBe(250);
    expect(result.segments.has("B:edit")).toBe(false);
    expect(result.segments.get("RUN:edit")?.cfm).toBe(250);
  });

  it("normalizes one-sided connections and reports terminals with no AHU path", () => {
    const connected = recommendDuctSegmentSizes([
      node({ ref: "EQ", kind: "mech-equipment", connected: [] }),
      edge("RUN", ["EQ", "T"]),
      node({ ref: "T", kind: "mech-terminal", connected: [], cfm: 100 }),
    ]);
    expect(connected.segments.get("RUN:edit")?.cfm).toBe(100);

    const orphan = recommendDuctSegmentSizes([
      node({ ref: "T", kind: "mech-terminal", connected: [], cfm: 100 }),
    ]);
    expect(orphan.findings).toContainEqual(
      expect.objectContaining({ code: "no-equipment-path", itemId: "T:edit" }),
    );
  });

  it("fails with a typed error when element references are ambiguous", () => {
    expect(() =>
      recommendDuctSegmentSizes([
        edge("DUP", []),
        node({ ref: "DUP", kind: "mech-fitting", connected: [] }),
      ]),
    ).toThrowError(DuctNetworkError);
    try {
      recommendDuctSegmentSizes([
        edge("DUP", []),
        node({ ref: "DUP", kind: "mech-fitting", connected: [] }),
      ]);
    } catch (error) {
      expect(error).toMatchObject({
        code: "duplicate-element-ref",
        elementRef: "DUP",
      });
    }
  });
});
