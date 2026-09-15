import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPascalNetwork, readRequiredCfm } from "./network.js";
import { readPascalScene } from "./scene.js";

type RawScene = { nodes: Record<string, Record<string, unknown>> };
const example = (): RawScene => JSON.parse(readFileSync(new URL("../examples/furnace-two-registers.json", import.meta.url), "utf8")) as RawScene;

describe("buildPascalNetwork", () => {
  it("rebuilds connectivity from coincident ports across runs, fittings, terminals, and equipment", () => {
    const network = buildPascalNetwork(readPascalScene(example()));
    const connected = (id: string) => network.connections.get(id);
    expect(connected("hvac-equipment_furnace")).toEqual(["duct-segment_main", "duct-segment_return"]);
    expect(connected("duct-segment_main")).toEqual(["duct-fitting_tee", "hvac-equipment_furnace"]);
    expect(connected("duct-fitting_tee")).toEqual(["duct-segment_main", "duct-segment_run_a", "duct-segment_run_b"]);
    expect(connected("duct-segment_run_a")).toEqual(["duct-fitting_tee", "duct-terminal_a"]);
    expect(connected("duct-segment_run_b")).toEqual(["duct-fitting_tee", "duct-terminal_b"]);
    expect(connected("duct-segment_return")).toEqual(["duct-terminal_return", "hvac-equipment_furnace"]);
    expect(network.findings).toEqual([]);
  });
  it("maps nodes to NetworkItems with node ids as elementRefs and equipment compatible with both sides", () => {
    const network = buildPascalNetwork(readPascalScene(example()));
    const byRef = new Map(network.items.map((item) => [item.elementRef, item]));
    expect(byRef.get("hvac-equipment_furnace")).toMatchObject({ kind: "equipment", airflowType: "unknown" });
    expect(byRef.get("duct-terminal_a")).toMatchObject({ kind: "terminal", airflowType: "supply", requiredCfm: 150 });
    expect(byRef.get("duct-terminal_return")).toMatchObject({ kind: "terminal", airflowType: "return", requiredCfm: null });
    expect(byRef.get("duct-segment_return")).toMatchObject({ kind: "segment", airflowType: "return" });
    expect(byRef.get("duct-fitting_tee")).toMatchObject({ kind: "fitting", airflowType: "supply" });
    expect(network.items.map((item) => item.id)).toEqual([...network.items.map((item) => item.id)].sort());
  });
  it("keeps supply and return ports apart even when they touch", () => {
    const scene = example();
    scene.nodes["duct-segment_return"]!.path = [[0, 1.1, 0], [-2, 1.1, 0]];
    const network = buildPascalNetwork(readPascalScene(scene));
    expect(network.connections.get("duct-segment_return")).not.toContain("duct-segment_main");
  });
  it("reports missing, invalid, and custom CFM readings on supply terminals only", () => {
    const scene = example();
    scene.nodes["duct-terminal_a"]!.metadata = {};
    scene.nodes["duct-terminal_b"]!.metadata = { requiredCfm: "lots" };
    const network = buildPascalNetwork(readPascalScene(scene));
    expect(network.findings).toEqual([
      expect.objectContaining({ code: "missing-required-cfm", severity: "warning", nodeId: "duct-terminal_a" }),
      expect.objectContaining({ code: "invalid-required-cfm", severity: "error", nodeId: "duct-terminal_b", detail: { raw: "lots" } }),
    ]);
    const custom = buildPascalNetwork(readPascalScene(scene), { requiredCfm: () => ({ kind: "present", cfm: 42 }) });
    expect(custom.findings).toEqual([]);
    expect(custom.items.find((item) => item.elementRef === "duct-terminal_b")).toMatchObject({ requiredCfm: 42 });
  });
  it("reads CFM from openmep.requiredCfm, requiredCfm, then cfm", () => {
    expect(readRequiredCfm({ openmep: { requiredCfm: 120 }, requiredCfm: 99 })).toEqual({ kind: "present", cfm: 120 });
    expect(readRequiredCfm({ cfm: 80 })).toEqual({ kind: "present", cfm: 80 });
    expect(readRequiredCfm({ requiredCfm: 0 })).toEqual({ kind: "invalid", raw: 0 });
    expect(readRequiredCfm({})).toEqual({ kind: "absent" });
    expect(readRequiredCfm({ airflow: 50 }, "airflow")).toEqual({ kind: "present", cfm: 50 });
  });
  it("flags scenes without equipment, omits condensers, and notes unknown fittings", () => {
    const scene = example();
    scene.nodes["hvac-equipment_furnace"]!.equipmentType = "condenser";
    scene.nodes["duct-fitting_tee"]!.fittingType = "wye";
    const network = buildPascalNetwork(readPascalScene(scene));
    expect(network.items.some((item) => item.kind === "equipment")).toBe(false);
    expect(network.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "no-equipment", severity: "error", nodeId: null }),
      expect.objectContaining({ code: "unsupported-fitting-type", nodeId: "duct-fitting_tee", detail: { fittingType: "wye" } }),
    ]));
    expect(network.items.find((item) => item.elementRef === "duct-fitting_tee")).toMatchObject({ kind: "fitting", connectedItemRefs: [] });
  });
  it("honours a custom mating tolerance", () => {
    const scene = example();
    scene.nodes["duct-segment_run_a"]!.path = [[4.5, 2.6, 0], [8, 2.6, 0], [8, 2.82, 0]];
    expect(buildPascalNetwork(readPascalScene(scene)).connections.get("duct-segment_run_a")).toEqual(["duct-terminal_a"]);
    expect(buildPascalNetwork(readPascalScene(scene), { toleranceM: 0.2 }).connections.get("duct-segment_run_a")).toEqual(["duct-fitting_tee", "duct-terminal_a"]);
  });
});

describe("detached-node", () => {
  const example = JSON.parse(readFileSync(new URL("../examples/furnace-two-registers.json", import.meta.url), "utf8")) as { nodes: Record<string, Record<string, unknown>> };
  it("warns for HVAC nodes whose parent chain misses rootNodeIds, and stays quiet without roots", () => {
    const detached = buildPascalNetwork(readPascalScene({ nodes: example.nodes, rootNodeIds: ["site_x"] }));
    const codes = detached.findings.filter((finding) => finding.code === "detached-node").map((finding) => finding.nodeId);
    expect(codes).toHaveLength(9);
    expect(codes).toContain("duct-segment_main");
    const attached = buildPascalNetwork(readPascalScene({ nodes: example.nodes, rootNodeIds: ["level_main"] }));
    expect(attached.findings.some((finding) => finding.code === "detached-node")).toBe(false);
    const bare = buildPascalNetwork(readPascalScene({ nodes: example.nodes }));
    expect(bare.findings.some((finding) => finding.code === "detached-node")).toBe(false);
  });
});
