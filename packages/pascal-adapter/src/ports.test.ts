import { describe, expect, it } from "vitest";
import {
  TERMINAL_COLLAR_LENGTH_M,
  areaEquivalentDiameterIn,
  ductFittingPorts,
  ductSegmentPorts,
  ductTerminalPorts,
  fittingLegLengthM,
  hvacEquipmentPorts,
  levelBaseElevations,
  worldPorts,
} from "./ports.js";
import { readPascalScene, type PascalDuctFitting, type PascalDuctTerminal, type PascalHvacEquipment, type Vec3 } from "./scene.js";

const close = (actual: Vec3, expected: Vec3) => {
  for (let axis = 0; axis < 3; axis++) expect(actual[axis]).toBeCloseTo(expected[axis]!, 6);
};
const terminal = (overrides: Partial<PascalDuctTerminal>): PascalDuctTerminal => ({
  id: "duct-terminal_t", type: "duct-terminal", parentId: null, metadata: {}, position: [1, 2, 3], rotation: 0, terminalType: "diffuser", mount: "floor",
  collarShape: "round", collarDiameter: 6, collarWidth: 10, collarHeight: 6, ...overrides,
});
const fitting = (overrides: Partial<PascalDuctFitting>): PascalDuctFitting => ({
  id: "duct-fitting_f", type: "duct-fitting", parentId: null, metadata: {}, position: [0, 0, 0], rotation: [0, 0, 0], fittingType: "tee", shape: "round", shape2: "round",
  diameter: 6, diameter2: 6, width: 14, height: 8, width2: 14, height2: 8, angle: 90, branchAngle: 90, system: "supply", ...overrides,
});
const equipment = (overrides: Partial<PascalHvacEquipment>): PascalHvacEquipment => ({
  id: "hvac-equipment_e", type: "hvac-equipment", parentId: null, metadata: {}, position: [0, 0, 0], rotation: 0, equipmentType: "furnace", width: 0.56, height: 1.1,
  supplyShape: "round", returnShape: "round", supplyDiameter: 8, returnDiameter: 8, supplyWidth: 12, supplyHeight: 8, returnWidth: 14, returnHeight: 8, ...overrides,
});

describe("port geometry mirrors Pascal's node definitions", () => {
  it("places terminal collars behind the face for each mount, with yaw applied", () => {
    const L = TERMINAL_COLLAR_LENGTH_M;
    close(ductTerminalPorts(terminal({ mount: "floor" }))[0]!.position, [1, 2 - L, 3]);
    close(ductTerminalPorts(terminal({ mount: "floor" }))[0]!.direction, [0, -1, 0]);
    close(ductTerminalPorts(terminal({ mount: "ceiling" }))[0]!.position, [1, 2 + L, 3]);
    close(ductTerminalPorts(terminal({ mount: "ceiling" }))[0]!.direction, [0, 1, 0]);
    close(ductTerminalPorts(terminal({ mount: "wall" }))[0]!.position, [1, 2, 3 - L]);
    close(ductTerminalPorts(terminal({ mount: "wall", rotation: Math.PI / 2 }))[0]!.position, [1 - L, 2, 3]);
    expect(ductTerminalPorts(terminal({ terminalType: "return-grille" }))[0]!.system).toBe("return");
    expect(ductTerminalPorts(terminal({ collarShape: "rect", collarWidth: 10, collarHeight: 6 }))[0]!.diameterIn).toBeCloseTo(2 * Math.sqrt(60 / Math.PI), 9);
  });
  it("puts the equipment supply collar on top and the return drop on the -X side, rotated by yaw", () => {
    const ports = hvacEquipmentPorts(equipment({}));
    close(ports[0]!.position, [0, 1.1, 0]);
    close(ports[1]!.position, [-0.28, 0.385, 0]);
    close(ports[1]!.direction, [-1, 0, 0]);
    const turned = hvacEquipmentPorts(equipment({ rotation: Math.PI / 2, position: [5, 0, 5] }));
    close(turned[1]!.position, [5, 0.385, 5 + 0.28]);
    expect(hvacEquipmentPorts(equipment({ equipmentType: "condenser" }))).toEqual([]);
  });
  it("derives fitting ports from leg lengths and the XYZ Euler rotation", () => {
    const main = fittingLegLengthM(6);
    expect(main).toBeCloseTo(0.1905, 9);
    const tee = ductFittingPorts(fitting({}))!;
    expect(tee.map((port) => port.portId)).toEqual(["inlet", "outlet", "branch"]);
    close(tee[0]!.position, [-main, 0, 0]);
    close(tee[2]!.position, [0, 0, fittingLegLengthM(6)]);
    const turned = ductFittingPorts(fitting({ rotation: [0, Math.PI / 2, 0] }))!;
    close(turned[0]!.position, [0, 0, main]);
    close(turned[0]!.direction, [0, 0, 1]);
    const elbow = ductFittingPorts(fitting({ fittingType: "elbow", angle: 90 }))!;
    close(elbow[1]!.position, [0, 0, main]);
    const reducer = ductFittingPorts(fitting({ fittingType: "reducer", diameter: 10, diameter2: 6 }))!;
    expect(reducer.map((port) => port.diameterIn)).toEqual([10, 6]);
    expect(ductFittingPorts(fitting({ fittingType: "end-cap" }))!.map((port) => port.portId)).toEqual(["inlet"]);
    expect(ductFittingPorts(fitting({ fittingType: "access-panel" }))).toEqual([]);
    expect(ductFittingPorts(fitting({ fittingType: "wye" }))).toBeNull();
  });
  it("exposes duct run ends with outward tangents and the area-equivalent size", () => {
    const [start, end] = ductSegmentPorts({ id: "duct-segment_s", type: "duct-segment", parentId: null, metadata: {}, path: [[0, 0, 0], [0, 2, 0], [3, 2, 0]], shape: "rect", diameter: 6, width: 14, height: 8, system: "supply" });
    close(start!.direction, [0, -1, 0]);
    close(end!.position, [3, 2, 0]);
    close(end!.direction, [1, 0, 0]);
    expect(end!.diameterIn).toBeCloseTo(areaEquivalentDiameterIn("rect", 6, 14, 8), 9);
    expect(areaEquivalentDiameterIn("oval", 6, 18, 8)).toBeCloseTo(2 * Math.sqrt(((18 - 8) * 8 + Math.PI * 16) / Math.PI), 9);
    expect(areaEquivalentDiameterIn("round", 6, 18, 8)).toBe(6);
  });
  it("stacks level elevations per building the way Pascal does and lifts ports by them", () => {
    const scene = readPascalScene({
      nodes: {
        building_1: { type: "building" },
        level_0: { type: "level", parentId: "building_1", level: 0, height: 3 },
        level_1: { type: "level", parentId: "building_1", level: 1, baseElevation: 0.2 },
        level_2: { type: "level", parentId: "building_1", level: 2 },
        "duct-terminal_up": { type: "duct-terminal", parentId: "level_1", position: [0, 0, 0], mount: "floor" },
      },
    });
    const elevations = levelBaseElevations(scene);
    expect(elevations.get("level_0")).toBe(0);
    expect(elevations.get("level_1")).toBeCloseTo(3.2, 9);
    expect(elevations.get("level_2")).toBeCloseTo(3.2 + 2.5, 9);
    const { ports } = worldPorts(scene);
    close(ports[0]!.position, [0, 3.2 - TERMINAL_COLLAR_LENGTH_M, 0]);
  });
});
