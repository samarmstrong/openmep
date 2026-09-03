import { describe, expect, it } from "vitest";

import { inferGeometricConnections, type ConnectionCandidate } from "./plan";

const TOL = 0.05;

function segment(
  id: string,
  from: [number, number],
  to: [number, number],
  z: [number, number] = [3, 3.3],
  airflowType: ConnectionCandidate["airflowType"] = "supply"
): ConnectionCandidate {
  const half = 0.15;
  return {
    elementRef: id,
    kind: "mech-segment",
    airflowType,
    min: [Math.min(from[0], to[0]) - half, z[0], Math.min(from[1], to[1]) - half],
    max: [Math.max(from[0], to[0]) + half, z[1], Math.max(from[1], to[1]) + half],
    bounds2D: {
      min: [Math.min(from[0], to[0]) - half, Math.min(from[1], to[1]) - half],
      max: [Math.max(from[0], to[0]) + half, Math.max(from[1], to[1]) + half]
    },
    ends: [from, to],
    halfWidth: half
  };
}

function node(
  id: string,
  kind: ConnectionCandidate["kind"],
  center: [number, number],
  size = 0.3,
  z: [number, number] = [3, 3.3],
  airflowType: ConnectionCandidate["airflowType"] = "supply"
): ConnectionCandidate {
  const h = size / 2;
  return {
    elementRef: id,
    kind,
    airflowType,
    min: [center[0] - h, z[0], center[1] - h],
    max: [center[0] + h, z[1], center[1] + h],
    bounds2D: { min: [center[0] - h, center[1] - h], max: [center[0] + h, center[1] + h] },
    ends: null,
    halfWidth: 0
  };
}

describe("inferGeometricConnections", () => {
  it("joins a duct run: equipment → segment → fitting → segment → terminal", () => {
    const items = [
      node("ahu", "mech-equipment", [0, 0], 1),
      segment("s1", [0.5, 0], [4.7, 0]),
      node("elbow", "mech-fitting", [5, 0], 0.6),
      segment("s2", [5, 0.3], [5, 3]),
      node("diffuser", "mech-terminal", [5, 3.3], 0.6)
    ];
    const connections = inferGeometricConnections(items, TOL);
    expect([...connections.get("s1")!].sort()).toEqual(["ahu", "elbow"]);
    expect([...connections.get("s2")!].sort()).toEqual(["diffuser", "elbow"]);
    expect(connections.get("ahu")).toEqual(new Set(["s1"]));
  });

  it("attaches a takeoff fitting mid-span but ignores a duct crossing at another elevation", () => {
    const main = segment("main", [0, 0], [10, 0]);
    const crossingBelow = segment("below", [5, -3], [5, 3], [2, 2.3]);
    const takeoff = node("tap", "mech-fitting", [5, 0.2], 0.2);
    const connections = inferGeometricConnections([main, crossingBelow, takeoff], TOL);
    expect(connections.get("main")).toEqual(new Set(["tap"]));
    expect(connections.get("below")).toBeUndefined();
  });

  it("never joins known, differing air systems", () => {
    const supply = segment("sa", [0, 0], [2, 0]);
    const ret = node("ra-fitting", "mech-fitting", [2.1, 0], 0.3, [3, 3.3], "return");
    const unknown = node("x", "mech-fitting", [2.1, 0], 0.3, [3, 3.3], "unknown");
    expect(inferGeometricConnections([supply, ret], TOL).size).toBe(0);
    expect(inferGeometricConnections([supply, unknown], TOL).get("sa")).toEqual(new Set(["x"]));
  });

  it("joins segments at an end of either, but not a run more than the tolerance away", () => {
    const a = segment("a", [0, 0], [2, 0]);
    const b = segment("b", [2.02, 0], [4, 0]);
    const flexLike = segment("f", [1, 0.1], [1, 2]);
    const parallel = segment("p", [2.5, 0.4], [3.5, 0.4]);
    const connections = inferGeometricConnections([a, b, flexLike, parallel], TOL);
    expect(connections.get("a")).toEqual(new Set(["b", "f"]));
    expect(connections.get("p")).toBeUndefined();
  });
});
