import { connectCoincidentPorts, type NetworkItem } from "@openmep/hvac-domain";
import { terminalSystem, worldPorts, type PascalPort } from "./ports.js";
import type { PascalDuctTerminal, PascalScene } from "./scene.js";

export type PascalFindingSeverity = "error" | "warning" | "info";
export type PascalFindingCode =
  | "no-equipment"
  | "missing-required-cfm"
  | "invalid-required-cfm"
  | "unsupported-fitting-type"
  | "no-equipment-path"
  | "mixed-system-segment"
  | "dangling-reference"
  | "detached-node"
  | "unsized-segment"
  | "undersized"
  | "oversized"
  | "shape-not-resized"
  | "diameter-out-of-host-range";

export type PascalFinding = {
  code: PascalFindingCode;
  severity: PascalFindingSeverity;
  /** `null` for scene-wide findings. */
  nodeId: string | null;
  message: string;
  detail?: Readonly<Record<string, unknown>>;
};

export type CfmReading = { kind: "present"; cfm: number } | { kind: "absent" } | { kind: "invalid"; raw: unknown };

export const DEFAULT_CFM_METADATA_KEY = "requiredCfm";

/**
 * Engineer-approved airflow for a terminal, read from Pascal's free-form
 * `metadata`: `metadata.openmep.<key>`, then `metadata.<key>`, then
 * `metadata.cfm`. A present but non-positive or non-numeric value is
 * `invalid`; no value is `absent`.
 */
export function readRequiredCfm(metadata: Readonly<Record<string, unknown>>, key: string = DEFAULT_CFM_METADATA_KEY): CfmReading {
  const openmep = metadata.openmep;
  const candidates: unknown[] = [
    typeof openmep === "object" && openmep !== null ? (openmep as Record<string, unknown>)[key] : undefined,
    metadata[key],
    metadata.cfm,
  ];
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? { kind: "present", cfm: raw } : { kind: "invalid", raw };
  }
  return { kind: "absent" };
}

export type BuildNetworkOptions = {
  /** Port mating tolerance in metres; Pascal's system graph uses 0.05. */
  toleranceM?: number;
  /** Override how a supply terminal's airflow is read. */
  requiredCfm?: (terminal: PascalDuctTerminal) => CfmReading;
};

export type PascalNetwork = {
  items: readonly NetworkItem[];
  ports: readonly PascalPort[];
  connections: ReadonlyMap<string, readonly string[]>;
  findings: readonly PascalFinding[];
};

/** HVAC node ids whose parent chain does not end at one of `rootNodeIds` (when the scene carries roots). */
function detachedHvacNodeIds(scene: PascalScene): string[] {
  if (scene.rootNodeIds === null) return [];
  const roots = new Set(scene.rootNodeIds);
  const detached: string[] = [];
  for (const id of [...scene.hvacNodes.keys()].sort()) {
    let current: string | null = id;
    const seen = new Set<string>();
    while (current !== null && !roots.has(current) && !seen.has(current)) {
      seen.add(current);
      current = scene.parentIds.get(current) ?? null;
    }
    if (current === null || seen.has(current)) detached.push(id);
  }
  return detached;
}

/**
 * Rebuild duct connectivity from port coincidence and express the scene as
 * `NetworkItem`s for `@openmep/hvac-domain`. Node ids double as
 * `elementRef`s so recommendations and findings map straight back to
 * Pascal nodes. Condensers carry no duct ports and are omitted; pipe and
 * refrigerant nodes are ignored.
 */
export function buildPascalNetwork(scene: PascalScene, options: BuildNetworkOptions = {}): PascalNetwork {
  const readCfm = options.requiredCfm ?? ((terminal: PascalDuctTerminal) => readRequiredCfm(terminal.metadata));
  const { ports, unsupportedFittingIds } = worldPorts(scene);
  const connections = connectCoincidentPorts(
    ports.map((port) => ({ itemRef: port.nodeId, position: port.position, system: port.system })),
    { toleranceM: options.toleranceM },
  );
  const findings: PascalFinding[] = unsupportedFittingIds.map((nodeId) => ({
    code: "unsupported-fitting-type",
    severity: "info",
    nodeId,
    message: `Fitting ${nodeId} has a type this adapter does not know; it is treated as unconnected.`,
    detail: { fittingType: (scene.hvacNodes.get(nodeId) as { fittingType?: string } | undefined)?.fittingType },
  }));
  const items: NetworkItem[] = [];
  let equipmentCount = 0;
  for (const node of [...scene.hvacNodes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const connectedItemRefs = connections.get(node.id) ?? [];
    switch (node.type) {
      case "duct-segment":
        items.push({ id: node.id, elementRef: node.id, kind: "segment", airflowType: node.system, connectedItemRefs });
        break;
      case "duct-fitting":
        items.push({ id: node.id, elementRef: node.id, kind: "fitting", airflowType: node.system, connectedItemRefs });
        break;
      case "duct-terminal": {
        const airflowType = terminalSystem(node);
        const label = airflowType === "supply" ? "Supply terminal" : "Return grille";
        let requiredCfm: number | null = null;
        const reading = readCfm(node);
        if (reading.kind === "present") requiredCfm = reading.cfm;
        else if (reading.kind === "absent") {
          // Supply CFM is the design input; return runs are sized only when the user gives grille CFM.
          findings.push({
            code: "missing-required-cfm",
            severity: airflowType === "supply" ? "warning" : "info",
            nodeId: node.id,
            message: airflowType === "supply"
              ? `${label} ${node.id} has no required CFM in metadata; it does not contribute to sizing.`
              : `${label} ${node.id} has no required CFM in metadata; its return run is left as drawn. Set metadata.requiredCfm to size it.`,
          });
        } else {
          findings.push({
            code: "invalid-required-cfm",
            severity: "error",
            nodeId: node.id,
            message: `${label} ${node.id} has a required CFM that is not a positive number.`,
            detail: { raw: reading.raw },
          });
        }
        items.push({ id: node.id, elementRef: node.id, kind: "terminal", airflowType, connectedItemRefs, requiredCfm });
        break;
      }
      case "hvac-equipment":
        if (node.equipmentType === "condenser") break;
        equipmentCount += 1;
        items.push({ id: node.id, elementRef: node.id, kind: "equipment", airflowType: "unknown", connectedItemRefs });
        break;
    }
  }
  for (const nodeId of detachedHvacNodeIds(scene)) {
    findings.push({
      code: "detached-node",
      severity: "warning",
      nodeId,
      message: `${nodeId} is not reachable from the scene's rootNodeIds; Pascal's editor drops such nodes when it opens the project and autosaves the loss. Parent it to a level under a building.`,
    });
  }
  if (equipmentCount === 0) {
    findings.push({
      code: "no-equipment",
      severity: "error",
      nodeId: null,
      message: "Scene has no furnace or air handler; runs cannot be traced to equipment.",
    });
  }
  return { items, ports, connections, findings };
}
