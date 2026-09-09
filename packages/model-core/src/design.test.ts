import { describe, expect, it } from "vitest";
import { AirflowChangeError, previewRoomAirflowChange } from "./design";
import { mechanicalEditNodeItemSchema, mechanicalEditItemSchema, planStoreySchema, spaceLoadSchema, type MechanicalEditItem, type MechanicalEditNodeItem, type PlanStorey } from "./types";

function node(ref: string, kind: "mech-equipment" | "mech-fitting" | "mech-terminal", refs: string[], room: string | null = null, cfm: number | null = null): MechanicalEditNodeItem {
  return mechanicalEditNodeItemSchema.parse({ id: `id-${ref}`, visualRef: ref, elementRef: ref, editKind: "node", kind, position: [0, 0], size: [1, 1], rotation: 0, airflowType: "supply", connectedItemIds: refs, spaceGlobalId: room, requiredCfm: cfm, spaceDesignCfm: room === "a" ? 200 : 300 });
}
function duct(ref: string, refs: string[]): MechanicalEditItem {
  return mechanicalEditItemSchema.parse({ id: `id-${ref}`, visualRef: ref, elementRef: ref, editKind: "edge", kind: "mech-segment", path: [[0, 0], [1, 0]], width: 0.5, airflowType: "supply", connectedItemIds: refs });
}
function fixture(units = "ft"): PlanStorey {
  const bounds = { min: [0, 0], max: [10, 10] };
  return planStoreySchema.parse({
    modelId: "model", planVersion: 1, globalId: "level", name: "Level", longName: null, elevation: 0, sortOrder: 0, units,
    origin3D: [0, 0, 0], uAxis3D: [1, 0, 0], vAxis3D: [0, 1, 0], upAxis3D: [0, 0, 1], worldBounds3D: { min: [0, 0, 0], max: [10, 10, 3] }, bounds, contextBounds: bounds, focusBounds: bounds,
    architecture: { spaces: ["a", "b"].map((globalId) => ({ modelId: "model", globalId, expressId: 1, ifcClass: "IfcSpace", storeyGlobalId: "level", kind: "space", polygons: [{ outer: [[0, 0], [1, 0], [1, 1]] }], bounds, presentationCategory: "building", sourceName: null, diagnostics: [], label: globalId, secondaryLabel: null, area: 100, labelPoint: [0.5, 0.5] })) },
    mechanicalEdit2D: [node("eq", "mech-equipment", ["main"]), duct("main", ["eq", "split"]), node("split", "mech-fitting", ["main", "a1", "a2", "b1"]), duct("a1", ["split", "t1"]), node("t1", "mech-terminal", ["a1"], "a", 100), duct("a2", ["split", "t2"]), node("t2", "mech-terminal", ["a2"], "a", 100), duct("b1", ["split", "t3"]), node("t3", "mech-terminal", ["b1"], "b", 300)],
    loads: { modelId: "model", storeyGlobalId: "level", planVersion: 1, spaces: ["a", "b"].map((spaceGlobalId) => spaceLoadSchema.parse({ spaceGlobalId, storeyGlobalId: "level", spaceTypeKey: "office", spaceTypeDisplayName: "Office", classificationConfidence: "heuristic", areaSqft: 100, occupants: 1, ventilation: { ra: 0.06, rp: 5, ez: 1, vbz: 11, voz: 11 }, thermal: { sensibleLoadBtuH: 4320, supplyDeltaTF: 20, cfm: 200 }, estimator: { cfmPerSqft: 1, cfm: 100 }, designCfm: spaceGlobalId === "a" ? 200 : 300 })), totals: { designCfm: 500, ventilationCfm: 22, sensibleLoadBtuH: 8640, spaceCount: 2 } },
  });
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
}

describe("room airflow preview", () => {
  it("splits room demand and accumulates shared main flow without changing another branch or thermal calculations", () => {
    const input = fixture(); const snapshot = structuredClone(input); freeze(input);
    const preview = previewRoomAirflowChange(input, "a", 600);
    expect(preview.terminalCount).toBe(2);
    expect(preview.changes.map(({ elementRef, beforeCfm, afterCfm }) => ({ elementRef, beforeCfm, afterCfm }))).toEqual([
      { elementRef: "a1", beforeCfm: 100, afterCfm: 300 }, { elementRef: "a2", beforeCfm: 100, afterCfm: 300 }, { elementRef: "main", beforeCfm: 500, afterCfm: 900 },
    ]);
    expect(preview.storey.mechanicalEdit2D.filter((item) => item.editKind === "node" && item.spaceGlobalId === "a")).toEqual([expect.objectContaining({ requiredCfm: 300, spaceDesignCfm: 600 }), expect.objectContaining({ requiredCfm: 300, spaceDesignCfm: 600 })]);
    for (const ref of ["b1", "t3"]) expect(preview.storey.mechanicalEdit2D.find((item) => item.elementRef === ref)).toBe(input.mechanicalEdit2D.find((item) => item.elementRef === ref));
    expect(preview.storey.loads.totals).toEqual({ ...input.loads.totals, designCfm: 900 });
    expect(preview.storey.loads.spaces[0]?.thermal).toBe(input.loads.spaces[0]?.thermal);
    expect(preview.storey.loads.spaces[0]?.ventilation).toBe(input.loads.spaces[0]?.ventilation);
    expect(input).toEqual(snapshot);
    const repeated = previewRoomAirflowChange(preview.storey, "a", 700);
    expect(repeated.storey.loads.spaces[0]?.diagnostics.filter((message) => message.startsWith("Manual airflow override:"))).toHaveLength(1);
  });
  it.each([["feet", 1 / 12], ["metres", 0.0254], ["mm", 25.4]] as const)("converts round diameters to %s", (units, factor) => {
    const preview = previewRoomAirflowChange(fixture(units), "a", 600);
    for (const change of preview.changes) {
      expect(change.afterWidth).toBeCloseTo(change.diameterIn * factor);
      expect(preview.storey.mechanicalEdit2D.find((item) => item.id === change.itemId)).toMatchObject({ width: change.afterWidth });
    }
  });
  it.each([0, -1, NaN, Infinity])("rejects invalid demand %s", (cfm) => expect(() => previewRoomAirflowChange(fixture(), "a", cfm)).toThrow(expect.objectContaining({ code: "invalid-airflow" })));
  it("rejects rooms, loads, terminals, and units that cannot support a preview", () => {
    expect(() => previewRoomAirflowChange(fixture(), "absent", 600)).toThrow(expect.objectContaining({ code: "missing-room" }));
    const noLoad = fixture(); noLoad.loads.spaces = [];
    expect(() => previewRoomAirflowChange(noLoad, "a", 600)).toThrow(expect.objectContaining({ code: "missing-load" }));
    const noTerminals = fixture(); noTerminals.mechanicalEdit2D = [];
    expect(() => previewRoomAirflowChange(noTerminals, "a", 600)).toThrow(expect.objectContaining({ code: "missing-terminals" }));
    expect(() => previewRoomAirflowChange(fixture("furlongs"), "a", 600)).toThrow(expect.objectContaining({ code: "unknown-units" }));
  });
  it("rejects disconnected topology", () => {
    const input = fixture(); input.mechanicalEdit2D = input.mechanicalEdit2D.map((item) => ({ ...item, connectedItemIds: [] }));
    expect(() => previewRoomAirflowChange(input, "a", 600)).toThrow(expect.objectContaining({ code: "no-equipment-path" }));
  });
  it("rejects omitted and unknown contributing demand", () => {
    const input = fixture(); input.mechanicalEdit2D.push(duct("dangling", ["split", "missing"]));
    expect(() => previewRoomAirflowChange(input, "a", 600)).toThrow(expect.objectContaining({ code: "incomplete-network" }));
    const unknown = fixture(); unknown.mechanicalEdit2D.push(node("unknown", "mech-terminal", ["split"]));
    expect(() => previewRoomAirflowChange(unknown, "a", 600)).toThrow(expect.objectContaining({ code: "incomplete-network" }));
  });
  it("allows known inactive terminals but rejects unidentified airflow types", () => {
    const input = fixture(); const inactive = node("inactive", "mech-terminal", ["split"], "b", 0); input.mechanicalEdit2D.push(inactive);
    expect(previewRoomAirflowChange(input, "a", 600).changes.find((change) => change.elementRef === "main")?.afterCfm).toBe(900);
    inactive.airflowType = "unknown";
    expect(() => previewRoomAirflowChange(input, "a", 600)).toThrow(expect.objectContaining({ code: "incomplete-network" }));
  });
  it("ignores invalid demand on disconnected systems", () => {
    const input = fixture(); input.mechanicalEdit2D.push({ ...node("unrelated", "mech-terminal", []), requiredCfm: -1 });
    expect(previewRoomAirflowChange(input, "a", 600).changes).toHaveLength(3);
  });
  it("wraps domain failures as typed preview errors", () => {
    const input = fixture(); input.mechanicalEdit2D.push({ ...input.mechanicalEdit2D[0]!, id: "duplicate" });
    expect(() => previewRoomAirflowChange(input, "a", 600)).toThrow(AirflowChangeError);
    expect(() => previewRoomAirflowChange(input, "a", 600)).toThrow(expect.objectContaining({ code: "domain-error" }));
  });
});
