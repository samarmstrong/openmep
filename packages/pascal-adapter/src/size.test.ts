import { readFileSync } from "node:fs";
import { rectangularEquivalentDiameterIn, sizeDuctForAirflow, sizeSupplyRoundDuct } from "@openmep/hvac-domain";
import { describe, expect, it } from "vitest";
import { PASCAL_DUCT_DIAMETER_RANGE_IN, sizePascalScene } from "./size.js";

type RawScene = { nodes: Record<string, Record<string, unknown>> };
const example = (): RawScene => JSON.parse(readFileSync(new URL("../examples/furnace-two-registers.json", import.meta.url), "utf8")) as RawScene;

describe("sizePascalScene", () => {
  it("sizes every supply run on a terminal-to-equipment path with the engine's own recommendation", () => {
    const result = sizePascalScene(example());
    const byId = new Map(result.segments.map((segment) => [segment.nodeId, segment]));
    expect([...byId.keys()]).toEqual(["duct-segment_main", "duct-segment_run_a", "duct-segment_run_b"]);
    expect(byId.get("duct-segment_main")).toMatchObject({ cfm: 250, role: "main", terminalNodeIds: ["duct-terminal_a", "duct-terminal_b"], actualDiameterIn: 6 });
    expect(byId.get("duct-segment_run_a")).toMatchObject({ cfm: 150, role: "runout", terminalNodeIds: ["duct-terminal_a"] });
    expect(byId.get("duct-segment_run_b")).toMatchObject({ cfm: 100, role: "runout" });
    for (const segment of result.segments) {
      expect(segment.recommended).toEqual(sizeSupplyRoundDuct({ cfm: segment.cfm, role: segment.role }));
      expect(segment.recommended.standardDiameterIn).toBeGreaterThan(6);
      expect(segment.comparison.status).toBe("undersized");
      expect(segment.patchedDiameterIn).toBe(segment.recommended.standardDiameterIn);
    }
    expect(result.summary).toMatchObject({ nodes: 9, segments: 4, fittings: 1, terminals: 3, equipment: 1, terminalsWithCfm: { supply: 2, return: 0, exhaust: 0, "outside-air": 0 }, sizedSegments: 3, patchedSegments: 3 });
  });
  it("emits one apply_patch update per sized run with the diameter and the fully merged metadata", () => {
    const result = sizePascalScene(example());
    expect(result.patches.map((patch) => patch.id)).toEqual(["duct-segment_main", "duct-segment_run_a", "duct-segment_run_b"]);
    const main = result.patches[0]!;
    const recommended = sizeSupplyRoundDuct({ cfm: 250, role: "main" });
    expect(main.op).toBe("update");
    expect(main.data.diameter).toBe(recommended.standardDiameterIn);
    expect(main.data.metadata).toMatchObject({
      tag: "trunk",
      openmep: { cfm: 250, role: "main", recommendedDiameterIn: recommended.standardDiameterIn, actualDiameterIn: recommended.standardDiameterIn, status: "ok", terminalNodeIds: ["duct-terminal_a", "duct-terminal_b"] },
    });
    const meta = main.data.metadata.openmep as { velocityFpm: number; frictionRatePer100ft: number; requiredDiameterIn: number };
    expect(meta.velocityFpm).toBeCloseTo(recommended.velocityFpm, 2);
    expect(meta.frictionRatePer100ft).toBeCloseTo(recommended.frictionRatePer100ft, 2);
    expect(meta.requiredDiameterIn).toBeCloseTo(recommended.exactDiameterIn, 2);
    for (const patch of result.patches) {
      expect(patch.data.diameter).toBeGreaterThanOrEqual(PASCAL_DUCT_DIAMETER_RANGE_IN.min);
      expect(patch.data.diameter).toBeLessThanOrEqual(PASCAL_DUCT_DIAMETER_RANGE_IN.max);
      expect(JSON.parse(JSON.stringify(patch))).toEqual(patch);
    }
  });
  it("grades undersized runs as errors and lists them first", () => {
    const result = sizePascalScene(example());
    expect(result.findings.filter((finding) => finding.code === "undersized").map((finding) => finding.nodeId)).toEqual(["duct-segment_main", "duct-segment_run_a", "duct-segment_run_b"]);
    expect(result.findings[0]).toMatchObject({ severity: "error" });
    expect(result.summary.findings).toEqual({ error: 3, warning: 0, info: 1 });
  });
  it("skips diameter patches for runs already at the recommended size and for --no-resize", () => {
    const scene = example();
    const recommended = sizeSupplyRoundDuct({ cfm: 100, role: "runout" }).standardDiameterIn;
    scene.nodes["duct-segment_run_b"]!.diameter = recommended;
    const result = sizePascalScene(scene);
    const runB = result.patches.find((patch) => patch.id === "duct-segment_run_b")!;
    expect(runB.data.diameter).toBeUndefined();
    expect(runB.data.metadata).toMatchObject({ openmep: { status: "ok" } });
    expect(result.summary.patchedSegments).toBe(2);
    const frozen = sizePascalScene(example(), { resizeRound: false });
    expect(frozen.patches.every((patch) => patch.data.diameter === undefined)).toBe(true);
    expect(frozen.patches[0]!.data.metadata).toMatchObject({ openmep: { status: "undersized" } });
  });
  it("records but does not resize rect trunks, comparing by ASHRAE equivalent diameter", () => {
    const scene = example();
    Object.assign(scene.nodes["duct-segment_main"]!, { shape: "rect", width: 14, height: 8 });
    const result = sizePascalScene(scene);
    const main = result.segments.find((segment) => segment.nodeId === "duct-segment_main")!;
    expect(main.actualDiameterIn).toBeCloseTo(rectangularEquivalentDiameterIn(14, 8), 9);
    expect(main.patchedDiameterIn).toBeNull();
    expect(main.comparison.status).toBe("oversized");
    expect(result.patches.find((patch) => patch.id === "duct-segment_main")!.data.diameter).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "oversized", severity: "info", nodeId: "duct-segment_main" }),
      expect.objectContaining({ code: "shape-not-resized", severity: "info", nodeId: "duct-segment_main" }),
    ]));
  });
  it("flags orphan supply runs and terminals without a path to equipment", () => {
    const scene = example();
    scene.nodes["duct-segment_orphan"] = { type: "duct-segment", parentId: "level_main", path: [[20, 2.6, 0], [24, 2.6, 0]], system: "supply" };
    scene.nodes["duct-segment_run_b"]!.path = [[4.1905, 2.6, 0.5], [4.1905, 2.6, 3], [4.1905, -0.12, 3]];
    const result = sizePascalScene(scene);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsized-segment", severity: "warning", nodeId: "duct-segment_orphan" }),
      expect.objectContaining({ code: "unsized-segment", severity: "warning", nodeId: "duct-segment_run_b" }),
      expect.objectContaining({ code: "no-equipment-path", severity: "error", nodeId: "duct-terminal_b" }),
    ]));
    expect(result.segments.find((segment) => segment.nodeId === "duct-segment_main")).toMatchObject({ cfm: 150 });
    expect(result.findings.some((finding) => finding.nodeId === "duct-segment_return")).toBe(false);
  });
  it("sizes the return drop once its grille has required CFM, with return velocity caps", () => {
    const scene = example();
    scene.nodes["duct-terminal_return"]!.metadata = { requiredCfm: 250 };
    const result = sizePascalScene(scene);
    const ret = result.segments.find((segment) => segment.nodeId === "duct-segment_return")!;
    expect(ret).toMatchObject({ system: "return", cfm: 250, role: "main", terminalNodeIds: ["duct-terminal_return"], actualDiameterIn: 8 });
    expect(ret.recommended).toEqual(sizeDuctForAirflow({ cfm: 250, role: "main", airflowType: "return" }));
    expect(ret.comparison.maxVelocityFpm).toBe(1200);
    expect(result.patches.find((patch) => patch.id === "duct-segment_return")?.data.diameter).toBe(ret.recommended.standardDiameterIn);
    expect(result.summary.terminalsWithCfm).toMatchObject({ supply: 2, return: 1 });
    const withoutCfm = sizePascalScene(example());
    expect(withoutCfm.findings).toContainEqual(expect.objectContaining({ code: "missing-required-cfm", severity: "info", nodeId: "duct-terminal_return" }));
  });
  it("refuses to write diameters outside Pascal's schema range and says so", () => {
    const scene = example();
    scene.nodes["duct-terminal_a"]!.metadata = { requiredCfm: 9000 };
    scene.nodes["duct-terminal_b"]!.metadata = { requiredCfm: 9000 };
    const result = sizePascalScene(scene);
    expect(result.segments.every((segment) => segment.recommended.standardDiameterIn > PASCAL_DUCT_DIAMETER_RANGE_IN.max)).toBe(true);
    expect(result.patches.every((patch) => patch.data.diameter === undefined)).toBe(true);
    expect(result.findings.filter((finding) => finding.code === "diameter-out-of-host-range")).toHaveLength(3);
  });
});
