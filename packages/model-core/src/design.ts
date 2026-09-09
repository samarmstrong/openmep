import { DuctNetworkError, recommendSupplyDuctSegments, type DuctNetworkFinding, type NetworkItem } from "@openmep/hvac-domain";
import type { MechanicalEditItem, PlanStorey } from "./types";

export type AirflowChangeErrorCode = "invalid-airflow" | "missing-room" | "missing-load" | "missing-terminals" | "unknown-units" | "incomplete-network" | "no-equipment-path" | "domain-error";
export class AirflowChangeError extends Error {
  constructor(readonly code: AirflowChangeErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AirflowChangeError";
  }
}
export type RoomAirflowChangePreview = {
  storey: PlanStorey;
  terminalCount: number;
  changes: Array<{ itemId: string; elementRef: string; beforeWidth: number | null; afterWidth: number; beforeCfm: number; afterCfm: number; diameterIn: number }>;
  findings: readonly DuctNetworkFinding[];
};

function inchesToPlanUnits(units: string): number {
  switch (units.trim().toLowerCase()) {
    case "ft": case "foot": case "feet": return 1 / 12;
    case "m": case "metre": case "metres": case "meter": case "meters": return 0.0254;
    case "mm": case "millimetre": case "millimetres": case "millimeter": case "millimeters": return 25.4;
    default: throw new AirflowChangeError("unknown-units", `Cannot convert duct diameter into plan units '${units}'.`);
  }
}
function toNetworkItem(item: MechanicalEditItem): NetworkItem {
  const base = { id: item.id, elementRef: item.elementRef, airflowType: item.airflowType, connectedItemRefs: item.connectedItemIds };
  if (item.editKind === "edge") return { ...base, kind: "segment" };
  const kind = item.kind === "mech-equipment" ? "equipment" : item.kind === "mech-terminal" ? "terminal" : "fitting";
  // Zero is a known inactive terminal, not a positive demand for the sizing engine.
  return { ...base, kind, requiredCfm: item.requiredCfm === 0 ? null : item.requiredCfm };
}

/** Preview a manual airflow scenario. Thermal/ventilation calculations are retained. */
export function previewRoomAirflowChange(storey: PlanStorey, spaceId: string, designCfm: number): RoomAirflowChangePreview {
  if (!Number.isFinite(designCfm) || designCfm <= 0) throw new AirflowChangeError("invalid-airflow", "Room design airflow must be positive and finite.");
  if (!storey.architecture.spaces.some((space) => space.globalId === spaceId)) throw new AirflowChangeError("missing-room", `Room ${spaceId} is not in this storey.`);
  if (!storey.loads.spaces.some((space) => space.spaceGlobalId === spaceId)) throw new AirflowChangeError("missing-load", `Room ${spaceId} has no design load record.`);
  const selected = storey.mechanicalEdit2D.filter((item) => item.editKind === "node" && item.kind === "mech-terminal" && item.airflowType === "supply" && item.spaceGlobalId === spaceId);
  if (!selected.length) throw new AirflowChangeError("missing-terminals", `Room ${spaceId} has no supply terminals.`);
  const factor = inchesToPlanUnits(storey.units);
  const selectedIds = new Set(selected.map((item) => item.id));
  const items = storey.mechanicalEdit2D;
  const byRef = new Map(items.map((item) => [item.elementRef, item]));
  const adjacent = new Map(items.map((item) => [item.elementRef, new Set<string>()]));
  for (const item of items) for (const ref of item.connectedItemIds) {
    adjacent.get(item.elementRef)!.add(ref);
    adjacent.get(ref)?.add(item.elementRef);
  }
  // Reject incomplete supply components: an omitted demand could undersize a shared main.
  const component = new Set(selected.map((item) => item.elementRef));
  const queue = [...component];
  for (let i = 0; i < queue.length; i++) {
    const ref = queue[i]!;
    const item = byRef.get(ref);
    if (!item) throw new AirflowChangeError("incomplete-network", `Supply network references missing item ${ref}.`);
    if (item.editKind === "node" && item.kind === "mech-terminal" && (item.airflowType === "supply" || item.airflowType === "unknown") && (item.airflowType === "unknown" || item.requiredCfm == null || !Number.isFinite(item.requiredCfm) || item.requiredCfm < 0)) {
      throw new AirflowChangeError("incomplete-network", `Terminal ${ref} has unknown or invalid contributing airflow.`);
    }
    for (const neighborRef of adjacent.get(ref) ?? []) {
      const neighbor = byRef.get(neighborRef);
      if (neighbor && neighbor.airflowType !== "supply" && neighbor.airflowType !== "unknown") continue;
      if (!component.has(neighborRef)) { component.add(neighborRef); queue.push(neighborRef); }
    }
  }
  const updated = items.map((item) => selectedIds.has(item.id) && item.editKind === "node" ? { ...item, spaceDesignCfm: designCfm, requiredCfm: designCfm / selected.length } : item);
  try {
    // Other disconnected systems cannot contribute to this room's duct flows.
    const network = (source: MechanicalEditItem[]) => source.filter((item) => component.has(item.elementRef)).map((item) => ({
      ...toNetworkItem(item), connectedItemRefs: item.connectedItemIds.filter((ref) => component.has(ref)),
    }));
    const before = recommendSupplyDuctSegments(network(items));
    const after = recommendSupplyDuctSegments(network(updated));
    const missingPath = after.findings.find((finding) => finding.code === "no-equipment-path" && selectedIds.has(finding.itemId));
    if (missingPath) throw new AirflowChangeError("no-equipment-path", missingPath.message);
    const previous = new Map(before.segments.map((segment) => [segment.itemId, segment]));
    const changes = after.segments.filter((segment) => segment.terminalItemIds.some((id) => selectedIds.has(id))).map((segment) => {
      const item = byRef.get(segment.elementRef)!;
      return { itemId: segment.itemId, elementRef: segment.elementRef, beforeWidth: item.editKind === "edge" ? item.width : null, afterWidth: segment.size.standardDiameterIn * factor, beforeCfm: previous.get(segment.itemId)?.cfm ?? 0, afterCfm: segment.cfm, diameterIn: segment.size.standardDiameterIn };
    });
    if (!changes.length) throw new AirflowChangeError("incomplete-network", "Room supply paths contain no duct segments to size.");
    const widths = new Map(changes.map((change) => [change.itemId, change.afterWidth]));
    const spaces = storey.loads.spaces.map((space) => space.spaceGlobalId === spaceId ? { ...space, designCfm, diagnostics: [...space.diagnostics.filter((message) => !message.startsWith("Manual airflow override:")), `Manual airflow override: ${designCfm} CFM; thermal and ventilation calculations retained.`] } : space);
    return {
      storey: { ...storey, mechanicalEdit2D: updated.map((item) => item.editKind === "edge" && widths.has(item.id) ? { ...item, width: widths.get(item.id)! } : item), loads: { ...storey.loads, spaces, totals: { ...storey.loads.totals, designCfm: spaces.reduce((sum, space) => sum + space.designCfm, 0) } } },
      terminalCount: selected.length, changes, findings: after.findings,
    };
  } catch (error) {
    if (error instanceof DuctNetworkError) throw new AirflowChangeError("domain-error", error.message, error);
    throw error;
  }
}
