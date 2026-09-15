import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PascalAdapterError } from "./errors.js";
import { readPascalScene } from "./scene.js";

const exampleText = readFileSync(new URL("../examples/furnace-two-registers.json", import.meta.url), "utf8");
const example = () => JSON.parse(exampleText) as { nodes: Record<string, Record<string, unknown>> };

describe("readPascalScene", () => {
  it("reads HVAC nodes and levels from an export_json scene and keeps parents for every node", () => {
    const scene = readPascalScene(example());
    expect(scene.nodeCount).toBe(10);
    expect(scene.hvacNodes.size).toBe(9);
    expect(scene.levels.get("level_main")).toMatchObject({ level: 0, baseElevation: 0, height: 3 });
    expect(scene.parentIds.get("duct-segment_main")).toBe("level_main");
    expect(scene.hvacNodes.get("duct-terminal_a")).toMatchObject({ type: "duct-terminal", mount: "ceiling", metadata: { requiredCfm: 150 } });
  });
  it("accepts a JSON string, the export_json wrapper, and an array of nodes", () => {
    expect(readPascalScene(exampleText).hvacNodes.size).toBe(9);
    expect(readPascalScene({ json: exampleText }).hvacNodes.size).toBe(9);
    expect(readPascalScene({ nodes: Object.values(example().nodes) }).hvacNodes.size).toBe(9);
  });
  it("applies Pascal's schema defaults to sparse hand-written nodes", () => {
    const scene = readPascalScene({ nodes: { "duct-segment_x": { type: "duct-segment", path: [[0, 0, 0], [1, 0, 0]] }, "hvac-equipment_y": { type: "hvac-equipment" } } });
    expect(scene.hvacNodes.get("duct-segment_x")).toMatchObject({ shape: "round", diameter: 6, width: 14, height: 8, system: "supply", parentId: null, metadata: {} });
    expect(scene.hvacNodes.get("hvac-equipment_y")).toMatchObject({ equipmentType: "furnace", height: 1.1, width: 0.56, supplyDiameter: 8 });
  });
  it("ignores non-HVAC nodes but records their parents", () => {
    const scene = readPascalScene({ nodes: { wall_1: { type: "wall", parentId: "level_1" }, level_1: { type: "level" } } });
    expect(scene.hvacNodes.size).toBe(0);
    expect(scene.parentIds.get("wall_1")).toBe("level_1");
  });
  it("throws typed errors for malformed input", () => {
    expect(() => readPascalScene("{not json")).toThrow(expect.objectContaining({ code: "invalid-json" }));
    expect(() => readPascalScene({ rootNodeIds: [] })).toThrow(expect.objectContaining({ code: "invalid-scene" }));
    expect(() => readPascalScene({ nodes: { "duct-segment_x": { type: "duct-segment", path: [[0, 0, 0]] } } })).toThrow(PascalAdapterError);
    expect(() => readPascalScene({ nodes: { "duct-segment_x": { type: "duct-segment", path: [[0, 0, 0], [1, "a", 0]] } } })).toThrow(expect.objectContaining({ code: "invalid-node", nodeId: "duct-segment_x" }));
    expect(() => readPascalScene({ nodes: { "duct-terminal_x": { type: "duct-terminal", mount: "roof" } } })).toThrow(/mount must be one of/);
    expect(() => readPascalScene({ nodes: { "duct-terminal_x": { type: "duct-terminal", metadata: [] } } })).toThrow(/metadata must be an object/);
  });
});
