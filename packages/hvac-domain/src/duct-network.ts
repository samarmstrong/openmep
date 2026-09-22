import { DuctSizingError, sizeDuctForAirflow, type AirflowType, type DuctRole, type RoundDuctSize } from "./round-duct.js";

export type { AirflowType } from "./round-duct.js";
/** Airflow systems the network engine propagates and sizes. */
export type SizedAirflowType = Exclude<AirflowType, "unknown">;
export const SIZED_AIRFLOW_TYPES: readonly SizedAirflowType[] = ["supply", "return", "exhaust", "outside-air"];

export type NetworkNode = {
  id: string;
  elementRef: string;
  kind: "equipment" | "fitting" | "terminal";
  airflowType: AirflowType;
  connectedItemRefs: readonly string[];
  requiredCfm?: number | null;
};
export type NetworkSegment = {
  id: string;
  elementRef: string;
  kind: "segment";
  airflowType: AirflowType;
  connectedItemRefs: readonly string[];
};
export type NetworkItem = NetworkNode | NetworkSegment;

export type DuctNetworkErrorCode = "duplicate-element-ref" | "duct-sizing-failed" | "invalid-terminal-airflow";
export class DuctNetworkError extends Error {
  readonly code: DuctNetworkErrorCode;
  readonly elementRef: string;
  constructor(code: DuctNetworkErrorCode, elementRef: string, message: string) {
    super(message);
    this.name = "DuctNetworkError";
    this.code = code;
    this.elementRef = elementRef;
  }
}
export type DuctNetworkFinding = {
  code: "dangling-reference" | "no-equipment-path" | "mixed-system-segment";
  message: string;
  itemId: string;
  elementRef: string;
};
export type DuctSegmentRecommendation = {
  itemId: string;
  elementRef: string;
  /** System whose terminals load this segment. */
  airflowType: SizedAirflowType;
  cfm: number;
  terminalItemIds: readonly string[];
  role: DuctRole;
  size: RoundDuctSize;
};
export type DuctNetworkResult = {
  segments: readonly DuctSegmentRecommendation[];
  findings: readonly DuctNetworkFinding[];
};
export type DuctNetworkOptions = {
  /** Systems to propagate (default: all of `SIZED_AIRFLOW_TYPES`). */
  airflowTypes?: readonly SizedAirflowType[];
};

const isCompatible = (item: NetworkItem, system: SizedAirflowType): boolean => item.airflowType === system || item.airflowType === "unknown";

/**
 * Propagate each positive-CFM terminal over one deterministic shortest path
 * of same-system (or unclassified) items to equipment and recommend every
 * traversed round segment, sized with that system's velocity caps. Supply
 * and return work alike: airflow direction does not change the CFM a
 * segment carries. An unclassified segment loaded by two systems is not
 * sized and is reported as `mixed-system-segment`.
 */
export function recommendDuctSegments(items: readonly NetworkItem[], options: DuctNetworkOptions = {}): DuctNetworkResult {
  const systems = options.airflowTypes ?? SIZED_AIRFLOW_TYPES;
  const itemByRef = new Map<string, NetworkItem>();
  const adjacency = new Map<string, Set<string>>();
  const findings: DuctNetworkFinding[] = [];
  for (const item of items) {
    if (itemByRef.has(item.elementRef)) {
      throw new DuctNetworkError("duplicate-element-ref", item.elementRef, `Network contains duplicate elementRef ${item.elementRef}.`);
    }
    itemByRef.set(item.elementRef, item);
    adjacency.set(item.elementRef, new Set());
  }
  for (const item of items) for (const connectedRef of item.connectedItemRefs) {
    if (!itemByRef.has(connectedRef)) {
      findings.push({ code: "dangling-reference", itemId: item.id, elementRef: item.elementRef, message: `${item.elementRef} references missing item ${connectedRef}.` });
    } else {
      adjacency.get(item.elementRef)!.add(connectedRef);
      adjacency.get(connectedRef)!.add(item.elementRef);
    }
  }
  type Load = { item: NetworkSegment; system: SizedAirflowType; cfm: number; terminalItemIds: Set<string> };
  const loads = new Map<string, Map<SizedAirflowType, Load>>();
  const terminals = items
    .filter((item): item is NetworkNode & { kind: "terminal"; airflowType: SizedAirflowType; requiredCfm: number } =>
      item.kind === "terminal" && item.requiredCfm != null && (systems as readonly AirflowType[]).includes(item.airflowType))
    .sort((a, b) => a.elementRef.localeCompare(b.elementRef));
  for (const terminal of terminals) {
    const system = terminal.airflowType;
    if (!Number.isFinite(terminal.requiredCfm) || terminal.requiredCfm <= 0) {
      throw new DuctNetworkError("invalid-terminal-airflow", terminal.elementRef, `${system} terminal ${terminal.elementRef} requires a positive finite requiredCfm.`);
    }
    const queue = [terminal.elementRef];
    const seen = new Set(queue);
    const parent = new Map<string, string>();
    let equipmentRef: string | undefined;
    while (queue.length > 0 && equipmentRef === undefined) {
      const currentRef = queue.shift()!;
      for (const neighborRef of [...(adjacency.get(currentRef) ?? [])].sort()) {
        if (seen.has(neighborRef)) continue;
        const neighbor = itemByRef.get(neighborRef)!;
        if (!isCompatible(neighbor, system)) continue;
        seen.add(neighborRef);
        parent.set(neighborRef, currentRef);
        if (neighbor.kind === "equipment") { equipmentRef = neighborRef; break; }
        queue.push(neighborRef);
      }
    }
    if (equipmentRef === undefined) {
      findings.push({ code: "no-equipment-path", itemId: terminal.id, elementRef: terminal.elementRef, message: `${system} terminal ${terminal.elementRef} has no ${system}-compatible path to equipment.` });
      continue;
    }
    for (let ref = equipmentRef; ref !== terminal.elementRef; ref = parent.get(ref)!) {
      const item = itemByRef.get(ref)!;
      if (item.kind !== "segment") continue;
      const bySystem = loads.get(ref) ?? new Map<SizedAirflowType, Load>();
      const load = bySystem.get(system) ?? { item, system, cfm: 0, terminalItemIds: new Set<string>() };
      load.cfm += terminal.requiredCfm;
      load.terminalItemIds.add(terminal.id);
      bySystem.set(system, load);
      loads.set(ref, bySystem);
    }
  }
  const segments: DuctSegmentRecommendation[] = [];
  for (const [elementRef, bySystem] of [...loads.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [load, ...others] = [...bySystem.values()];
    if (others.length > 0) {
      const names = [...bySystem.keys()].join(" and ");
      findings.push({ code: "mixed-system-segment", itemId: load!.item.id, elementRef, message: `${elementRef} is unclassified and carries both ${names} air; classify it or separate the systems. It was not sized.` });
      continue;
    }
    const { item, system, cfm, terminalItemIds } = load!;
    const touchesEquipment = [...(adjacency.get(elementRef) ?? [])].some((ref) => {
      const neighbor = itemByRef.get(ref);
      return neighbor?.kind === "equipment" && isCompatible(neighbor, system);
    });
    const role: DuctRole = touchesEquipment ? "main" : terminalItemIds.size === 1 ? "runout" : "branch";
    try {
      const size = sizeDuctForAirflow({ cfm, role, airflowType: system });
      segments.push({ itemId: item.id, elementRef, airflowType: system, cfm, terminalItemIds: [...terminalItemIds].sort(), role, size });
    } catch (error) {
      const detail = error instanceof DuctSizingError ? error.message : String(error);
      throw new DuctNetworkError("duct-sizing-failed", elementRef, `Could not size ${system} duct ${elementRef} at ${cfm.toFixed(1)} CFM: ${detail}`);
    }
  }
  return { segments, findings: findings.sort((a, b) => a.elementRef.localeCompare(b.elementRef) || a.code.localeCompare(b.code)) };
}

/** Supply-only propagation; see `recommendDuctSegments`. */
export function recommendSupplyDuctSegments(items: readonly NetworkItem[]): DuctNetworkResult {
  return recommendDuctSegments(items, { airflowTypes: ["supply"] });
}
