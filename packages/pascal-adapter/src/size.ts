import {
  compareRoundDuctSize,
  flatOvalEquivalentDiameterIn,
  recommendDuctSegments,
  rectangularEquivalentDiameterIn,
  roundDuctFrictionRate,
  roundDuctVelocityFpm,
  SIZED_AIRFLOW_TYPES,
  type DuctRole,
  type RoundDuctSize,
  type RoundDuctSizeComparison,
  type SizedAirflowType,
} from "@openmep/hvac-domain";
import { buildPascalNetwork, type BuildNetworkOptions, type PascalFinding, type PascalNetwork } from "./network.js";
import { readPascalScene, type DuctShape, type PascalDuctSegment, type PascalScene, type PascalSystem } from "./scene.js";

/** `duct-segment.diameter` bounds in Pascal's schema, inches. */
export const PASCAL_DUCT_DIAMETER_RANGE_IN = { min: 2, max: 48 } as const;
export const DEFAULT_METADATA_KEY = "openmep";

export type PascalSizingOptions = BuildNetworkOptions & {
  /** Metadata key the adapter writes its results under (default `openmep`). */
  metadataKey?: string;
  /** Emit `diameter` updates for round segments (default true). */
  resizeRound?: boolean;
};

export type PascalSegmentSizing = {
  nodeId: string;
  shape: DuctShape;
  system: PascalSystem;
  cfm: number;
  role: DuctRole;
  terminalNodeIds: readonly string[];
  recommended: RoundDuctSize;
  /** Round diameter, or the ASHRAE circular equivalent of a rect/oval section, inches. */
  actualDiameterIn: number;
  comparison: RoundDuctSizeComparison;
  /** Diameter written by the patch, or `null` when geometry is left as is. */
  patchedDiameterIn: number | null;
};

/** One `apply_patch` operation; `metadata` is the full merged record because Pascal's update is a shallow merge. */
export type PascalUpdatePatch = {
  op: "update";
  id: string;
  data: { diameter?: number; metadata: Record<string, unknown> };
};

export type PascalSizingSummary = {
  nodes: number;
  segments: number;
  fittings: number;
  terminals: number;
  equipment: number;
  /** Terminals with required CFM, per system (Pascal draws supply and return). */
  terminalsWithCfm: Record<SizedAirflowType, number>;
  sizedSegments: number;
  patchedSegments: number;
  /** Patches emitted, including metadata-only updates. */
  patches: number;
  findings: Record<"error" | "warning" | "info", number>;
};

export type PascalSizingResult = {
  network: PascalNetwork;
  segments: readonly PascalSegmentSizing[];
  findings: readonly PascalFinding[];
  patches: readonly PascalUpdatePatch[];
  summary: PascalSizingSummary;
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Structural equality for JSON-shaped values (key order ignored). */
function sameRecord(existing: unknown, next: unknown): boolean {
  if (existing === next) return true;
  if (typeof existing !== typeof next || existing === null || next === null || typeof next !== "object") return false;
  if (Array.isArray(existing) !== Array.isArray(next)) return false;
  const a = existing as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameRecord(a[key], b[key]));
}

function actualDiameterIn(node: PascalDuctSegment): number {
  if (node.shape === "rect") return rectangularEquivalentDiameterIn(node.width, node.height);
  if (node.shape === "oval") return flatOvalEquivalentDiameterIn(node.width, node.height);
  return node.diameter;
}

/** Size a network already built from a scene; see `sizePascalScene`. */
export function sizePascalNetwork(scene: PascalScene, network: PascalNetwork, options: PascalSizingOptions = {}): PascalSizingResult {
  const metadataKey = options.metadataKey ?? DEFAULT_METADATA_KEY;
  const resizeRound = options.resizeRound ?? true;
  const findings: PascalFinding[] = [...network.findings];
  const result = recommendDuctSegments(network.items, { airflowTypes: ["supply", "return"] });
  for (const finding of result.findings) {
    findings.push({ code: finding.code, severity: "error", nodeId: finding.elementRef, message: finding.message });
  }
  const segments: PascalSegmentSizing[] = [];
  const patches: PascalUpdatePatch[] = [];
  for (const recommendation of result.segments) {
    const node = scene.hvacNodes.get(recommendation.elementRef);
    if (node?.type !== "duct-segment") continue;
    const actual = actualDiameterIn(node);
    const comparison = compareRoundDuctSize({ actualDiameterIn: actual, recommended: recommendation.size, airflowType: recommendation.airflowType, role: recommendation.role });
    const standard = recommendation.size.standardDiameterIn;
    let patchedDiameterIn: number | null = null;
    if (comparison.status === "undersized") {
      findings.push({
        code: "undersized",
        severity: "error",
        nodeId: node.id,
        message: `${node.id} carries ${round3(recommendation.cfm)} CFM at ${round3(actual)} in equivalent; ${standard} in round is required (${round3(comparison.actualVelocityFpm)} fpm, ${round3(comparison.actualFrictionRatePer100ft)} in. w.g./100 ft).`,
        detail: { cfm: recommendation.cfm, actualDiameterIn: actual, recommendedDiameterIn: standard, velocityExceeded: comparison.velocityExceeded },
      });
    } else if (comparison.status === "oversized") {
      findings.push({
        code: "oversized",
        severity: "info",
        nodeId: node.id,
        message: `${node.id} carries ${round3(recommendation.cfm)} CFM at ${round3(actual)} in equivalent; ${standard} in round would suffice.`,
        detail: { cfm: recommendation.cfm, actualDiameterIn: actual, recommendedDiameterIn: standard },
      });
    }
    if (node.shape !== "round") {
      if (comparison.status !== "ok") {
        findings.push({
          code: "shape-not-resized",
          severity: "info",
          nodeId: node.id,
          message: `${node.id} is a ${node.shape} section; the adapter records the recommendation in metadata but only resizes round runs.`,
        });
      }
    } else if (resizeRound && node.diameter !== standard) {
      if (standard >= PASCAL_DUCT_DIAMETER_RANGE_IN.min && standard <= PASCAL_DUCT_DIAMETER_RANGE_IN.max) {
        patchedDiameterIn = standard;
      } else {
        findings.push({
          code: "diameter-out-of-host-range",
          severity: "error",
          nodeId: node.id,
          message: `${node.id} needs ${standard} in, outside Pascal's ${PASCAL_DUCT_DIAMETER_RANGE_IN.min}–${PASCAL_DUCT_DIAMETER_RANGE_IN.max} in duct-segment range; split the run or use a rect trunk.`,
          detail: { recommendedDiameterIn: standard },
        });
      }
    }
    const afterDiameterIn = patchedDiameterIn ?? actual;
    const record = {
      cfm: round3(recommendation.cfm),
      role: recommendation.role,
      recommendedDiameterIn: standard,
      requiredDiameterIn: round3(recommendation.size.exactDiameterIn),
      actualDiameterIn: round3(afterDiameterIn),
      velocityFpm: round3(roundDuctVelocityFpm(recommendation.cfm, afterDiameterIn)),
      frictionRatePer100ft: round3(roundDuctFrictionRate(recommendation.cfm, afterDiameterIn)),
      status: patchedDiameterIn === null ? comparison.status : "ok",
      terminalNodeIds: [...recommendation.terminalItemIds],
    };
    // Idempotent: a segment whose geometry and recorded result already match gets no patch, so re-running creates no undo step.
    if (patchedDiameterIn !== null || !sameRecord(node.metadata[metadataKey], record)) {
      const data: PascalUpdatePatch["data"] = { metadata: { ...node.metadata, [metadataKey]: record } };
      if (patchedDiameterIn !== null) data.diameter = patchedDiameterIn;
      patches.push({ op: "update", id: node.id, data });
    }
    segments.push({
      nodeId: node.id,
      shape: node.shape,
      system: node.system,
      cfm: recommendation.cfm,
      role: recommendation.role,
      terminalNodeIds: recommendation.terminalItemIds,
      recommended: recommendation.size,
      actualDiameterIn: actual,
      comparison,
      patchedDiameterIn,
    });
  }
  const sizedIds = new Set(segments.map((segment) => segment.nodeId));
  // Supply runs should always size; return runs only once the user has given some grille CFM.
  const expected = new Set<PascalSystem>(["supply"]);
  if (network.items.some((item) => item.kind === "terminal" && item.airflowType === "return" && item.requiredCfm != null)) expected.add("return");
  for (const node of [...scene.hvacNodes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (node.type === "duct-segment" && expected.has(node.system) && !sizedIds.has(node.id)) {
      findings.push({
        code: "unsized-segment",
        severity: "warning",
        nodeId: node.id,
        message: `${node.id} is a ${node.system} run on no path from a terminal with required CFM to equipment; check its connections.`,
      });
    }
  }
  const severityOrder: Record<PascalFinding["severity"], number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || (a.nodeId ?? "").localeCompare(b.nodeId ?? "") || a.code.localeCompare(b.code));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const items = network.items;
  return {
    network,
    segments,
    findings,
    patches,
    summary: {
      nodes: scene.hvacNodes.size,
      segments: items.filter((item) => item.kind === "segment").length,
      fittings: items.filter((item) => item.kind === "fitting").length,
      terminals: items.filter((item) => item.kind === "terminal").length,
      equipment: items.filter((item) => item.kind === "equipment").length,
      terminalsWithCfm: Object.fromEntries(SIZED_AIRFLOW_TYPES.map((system) => [system, items.filter((item) => item.kind === "terminal" && item.airflowType === system && item.requiredCfm != null).length])) as Record<SizedAirflowType, number>,
      sizedSegments: segments.length,
      patchedSegments: segments.filter((segment) => segment.patchedDiameterIn !== null).length,
      patches: patches.length,
      findings: counts,
    },
  };
}

/**
 * Pascal scene in, sized system out: findings plus an `apply_patch` batch
 * that sets round `duct-segment.diameter` to the equal-friction standard
 * size and records airflow, velocity, and friction under `metadata.openmep`.
 * Throws typed `PascalAdapterError` for malformed scenes and lets
 * `DuctNetworkError` propagate when a run exceeds the standard size range.
 */
export function sizePascalScene(input: unknown, options: PascalSizingOptions = {}): PascalSizingResult {
  const scene = readPascalScene(input);
  return sizePascalNetwork(scene, buildPascalNetwork(scene, options), options);
}
