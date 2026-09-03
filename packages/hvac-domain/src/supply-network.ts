import { DuctSizingError, sizeSupplyRoundDuct, type AirflowType, type DuctRole, type RoundDuctSize } from "./round-duct.js";

export type { AirflowType } from "./round-duct.js";
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
  code: "dangling-reference" | "no-equipment-path";
  message: string;
  itemId: string;
  elementRef: string;
};
export type SupplyDuctSegmentRecommendation = {
  itemId: string;
  elementRef: string;
  cfm: number;
  terminalItemIds: readonly string[];
  role: DuctRole;
  size: RoundDuctSize;
};
export type SupplyDuctNetworkResult = {
  segments: readonly SupplyDuctSegmentRecommendation[];
  findings: readonly DuctNetworkFinding[];
};

function isSupplyCompatible(item: NetworkItem): boolean {
  return item.airflowType === "supply" || item.airflowType === "unknown";
}
function isSupplyTerminal(item: NetworkItem): item is NetworkNode & { kind: "terminal"; requiredCfm: number } {
  return item.kind === "terminal" && item.airflowType === "supply" && item.requiredCfm != null;
}

/**
 * Propagate each positive-CFM supply terminal over one deterministic shortest
 * compatible path to equipment and recommend every traversed round segment.
 */
export function recommendSupplyDuctSegments(items: readonly NetworkItem[]): SupplyDuctNetworkResult {
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
  const accumulated = new Map<string, { item: NetworkSegment; cfm: number; terminalItemIds: Set<string> }>();
  const terminals = items.filter(isSupplyTerminal).sort((a, b) => a.elementRef.localeCompare(b.elementRef));
  for (const terminal of terminals) {
    if (!Number.isFinite(terminal.requiredCfm) || terminal.requiredCfm <= 0) {
      throw new DuctNetworkError("invalid-terminal-airflow", terminal.elementRef, `Supply terminal ${terminal.elementRef} requires a positive finite requiredCfm.`);
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
        if (!isSupplyCompatible(neighbor)) continue;
        seen.add(neighborRef);
        parent.set(neighborRef, currentRef);
        if (neighbor.kind === "equipment") { equipmentRef = neighborRef; break; }
        queue.push(neighborRef);
      }
    }
    if (equipmentRef === undefined) {
      findings.push({ code: "no-equipment-path", itemId: terminal.id, elementRef: terminal.elementRef, message: `Supply terminal ${terminal.elementRef} has no compatible path to equipment.` });
      continue;
    }
    for (let ref = equipmentRef; ref !== terminal.elementRef; ref = parent.get(ref)!) {
      const item = itemByRef.get(ref)!;
      if (item.kind === "segment") {
        const entry = accumulated.get(ref) ?? { item, cfm: 0, terminalItemIds: new Set<string>() };
        entry.cfm += terminal.requiredCfm;
        entry.terminalItemIds.add(terminal.id);
        accumulated.set(ref, entry);
      }
    }
  }
  const segments = [...accumulated.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([elementRef, entry]) => {
    const touchesEquipment = [...(adjacency.get(elementRef) ?? [])].some((ref) => {
      const neighbor = itemByRef.get(ref);
      return neighbor?.kind === "equipment" && isSupplyCompatible(neighbor);
    });
    const role: DuctRole = touchesEquipment ? "main" : entry.terminalItemIds.size === 1 ? "runout" : "branch";
    try {
      const size = sizeSupplyRoundDuct({ cfm: entry.cfm, role });
      return { itemId: entry.item.id, elementRef, cfm: entry.cfm, terminalItemIds: [...entry.terminalItemIds].sort(), role, size };
    } catch (error) {
      const detail = error instanceof DuctSizingError ? error.message : String(error);
      throw new DuctNetworkError("duct-sizing-failed", elementRef, `Could not size duct ${elementRef} at ${entry.cfm.toFixed(1)} CFM: ${detail}`);
    }
  });
  return { segments, findings: findings.sort((a, b) => a.elementRef.localeCompare(b.elementRef) || a.code.localeCompare(b.code)) };
}
