import { DEFAULT_FRICTION_RATE_PER_100FT, DuctSizingError, sizeDuctForAirflow, type AirflowType, type DuctRole, type RoundDuctSize } from "./round-duct.js";

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
  /** Fittings and terminals: equivalent length of straight duct for this fitting's loss, ft (Manual D style). Counted in effective length when `fan` is given. */
  equivalentLengthFt?: number | null;
};
export type NetworkSegment = {
  id: string;
  elementRef: string;
  kind: "segment";
  airflowType: AirflowType;
  connectedItemRefs: readonly string[];
  /** Measured straight length, ft. Required on every sized segment when `fan` is given. */
  lengthFt?: number | null;
};
export type NetworkItem = NetworkNode | NetworkSegment;

export type DuctNetworkErrorCode =
  | "duplicate-element-ref"
  | "duct-sizing-failed"
  | "invalid-terminal-airflow"
  | "invalid-fan"
  | "missing-length"
  | "non-positive-available-static";
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
  code: "dangling-reference" | "no-equipment-path" | "mixed-system-segment" | "friction-rate-out-of-range" | "missing-equivalent-length";
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
/** Blower data that turns a fixed friction rate into one derived from available static pressure. */
export type FanStatic = {
  /** External static pressure the blower delivers at design airflow, in. w.g. */
  externalStaticInWg: number;
  /** Pressure drops of devices outside the duct runs (coil, filter, registers, grilles, dampers), in. w.g., by name. */
  componentLossesInWg?: Readonly<Record<string, number>>;
};
/** The longest effective run of one system: measured segment lengths plus fitting equivalent lengths. */
export type EffectivePath = {
  airflowType: SizedAirflowType;
  terminalItemId: string;
  /** Element refs from the terminal to (and excluding) the equipment. */
  itemRefs: readonly string[];
  measuredLengthFt: number;
  equivalentLengthFt: number;
  effectiveLengthFt: number;
};
/** Manual D style design friction rate: FR = available static × 100 / total effective length. */
export type DesignFrictionRate = {
  externalStaticInWg: number;
  componentLossesInWg: number;
  availableStaticInWg: number;
  totalEffectiveLengthFt: number;
  frictionRatePer100ft: number;
  /** Longest path per system that had terminals; the sum of their effective lengths is the TEL. */
  paths: readonly EffectivePath[];
};
export type DuctNetworkResult = {
  segments: readonly DuctSegmentRecommendation[];
  findings: readonly DuctNetworkFinding[];
  /** Present when `fan` was given. */
  design: DesignFrictionRate | null;
};
export type DuctNetworkOptions = {
  /** Systems to propagate (default: all of `SIZED_AIRFLOW_TYPES`). */
  airflowTypes?: readonly SizedAirflowType[];
  /** When given, the friction rate is derived from available static pressure over the total effective length instead of the default fixed rate. */
  fan?: FanStatic | null;
};

/** Manual D's acceptable friction-rate range ("the wedge"), in. w.g. per 100 ft. */
export const FRICTION_RATE_RANGE_PER_100FT = { min: 0.06, max: 0.18 } as const;

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

function validateFan(fan: FanStatic): { externalStaticInWg: number; componentLossesInWg: number } {
  if (!Number.isFinite(fan.externalStaticInWg) || fan.externalStaticInWg <= 0) {
    throw new DuctNetworkError("invalid-fan", "fan", `fan.externalStaticInWg must be a positive finite number of in. w.g., got ${fan.externalStaticInWg}.`);
  }
  let componentLossesInWg = 0;
  for (const [name, loss] of Object.entries(fan.componentLossesInWg ?? {})) {
    if (!Number.isFinite(loss) || loss < 0) throw new DuctNetworkError("invalid-fan", "fan", `fan.componentLossesInWg.${name} must be a finite non-negative number of in. w.g., got ${loss}.`);
    componentLossesInWg += loss;
  }
  const availableStaticInWg = fan.externalStaticInWg - componentLossesInWg;
  if (availableStaticInWg <= 0) {
    throw new DuctNetworkError("non-positive-available-static", "fan", `Component losses (${round4(componentLossesInWg)} in. w.g.) consume the external static pressure (${fan.externalStaticInWg} in. w.g.); no pressure is left for the ducts.`);
  }
  return { externalStaticInWg: fan.externalStaticInWg, componentLossesInWg };
}

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
  const fan = options.fan ? validateFan(options.fan) : null;
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
  const longestPath = new Map<SizedAirflowType, EffectivePath>();
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
    if (fan !== null) {
      const path: EffectivePath = { airflowType: system, terminalItemId: terminal.id, itemRefs: [], measuredLengthFt: 0, equivalentLengthFt: 0, effectiveLengthFt: 0 };
      // `parent` maps each reached item back toward the terminal; walk equipment → terminal and build terminal-first order.
      const refs: string[] = [terminal.elementRef];
      for (let ref = parent.get(equipmentRef)!; ref !== terminal.elementRef; ref = parent.get(ref)!) refs.splice(1, 0, ref);
      for (const ref of refs) {
        const item = itemByRef.get(ref)!;
        if (item.kind === "segment") {
          if (item.lengthFt == null || !Number.isFinite(item.lengthFt) || item.lengthFt < 0) {
            throw new DuctNetworkError("missing-length", item.elementRef, `${item.elementRef} needs a finite non-negative lengthFt to size from available static pressure.`);
          }
          path.measuredLengthFt += item.lengthFt;
        } else if (item.kind === "fitting" || item.kind === "terminal") {
          if (item.equivalentLengthFt == null) {
            if (item.kind === "fitting" && !findings.some((finding) => finding.code === "missing-equivalent-length" && finding.elementRef === item.elementRef)) {
              findings.push({ code: "missing-equivalent-length", itemId: item.id, elementRef: item.elementRef, message: `${item.elementRef} has no equivalentLengthFt; its loss is counted as zero in the effective length.` });
            }
          } else if (!Number.isFinite(item.equivalentLengthFt) || item.equivalentLengthFt < 0) {
            throw new DuctNetworkError("missing-length", item.elementRef, `${item.elementRef} equivalentLengthFt must be a finite non-negative number of feet.`);
          } else path.equivalentLengthFt += item.equivalentLengthFt;
        }
      }
      path.itemRefs = refs;
      path.effectiveLengthFt = path.measuredLengthFt + path.equivalentLengthFt;
      const current = longestPath.get(system);
      if (current === undefined || path.effectiveLengthFt > current.effectiveLengthFt) longestPath.set(system, path);
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
  let design: DesignFrictionRate | null = null;
  if (fan !== null) {
    const paths = [...longestPath.values()].sort((a, b) => a.airflowType.localeCompare(b.airflowType));
    const totalEffectiveLengthFt = paths.reduce((sum, path) => sum + path.effectiveLengthFt, 0);
    if (totalEffectiveLengthFt <= 0) {
      throw new DuctNetworkError("missing-length", "fan", "Total effective length is zero: give segments lengthFt (and fittings equivalentLengthFt) on at least one terminal-to-equipment path.");
    }
    const availableStaticInWg = fan.externalStaticInWg - fan.componentLossesInWg;
    const frictionRatePer100ft = round4((availableStaticInWg * 100) / totalEffectiveLengthFt);
    design = { externalStaticInWg: fan.externalStaticInWg, componentLossesInWg: round4(fan.componentLossesInWg), availableStaticInWg: round4(availableStaticInWg), totalEffectiveLengthFt: round4(totalEffectiveLengthFt), frictionRatePer100ft, paths };
    if (frictionRatePer100ft < FRICTION_RATE_RANGE_PER_100FT.min || frictionRatePer100ft > FRICTION_RATE_RANGE_PER_100FT.max) {
      const direction = frictionRatePer100ft < FRICTION_RATE_RANGE_PER_100FT.min ? "below" : "above";
      findings.push({ code: "friction-rate-out-of-range", itemId: "fan", elementRef: "fan", message: `Design friction rate ${frictionRatePer100ft} in. w.g./100 ft is ${direction} the ${FRICTION_RATE_RANGE_PER_100FT.min}–${FRICTION_RATE_RANGE_PER_100FT.max} range; ${direction === "below" ? "runs are long or available static is low: shorten runs, reduce device losses, or pick a stronger blower" : "runs are short: velocity caps will govern sizes"}.` });
    }
  }
  const frictionRatePer100ft = design?.frictionRatePer100ft ?? DEFAULT_FRICTION_RATE_PER_100FT;
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
      const size = sizeDuctForAirflow({ cfm, role, airflowType: system, frictionRatePer100ft });
      segments.push({ itemId: item.id, elementRef, airflowType: system, cfm, terminalItemIds: [...terminalItemIds].sort(), role, size });
    } catch (error) {
      const detail = error instanceof DuctSizingError ? error.message : String(error);
      throw new DuctNetworkError("duct-sizing-failed", elementRef, `Could not size ${system} duct ${elementRef} at ${cfm.toFixed(1)} CFM: ${detail}`);
    }
  }
  return { segments, findings: findings.sort((a, b) => a.elementRef.localeCompare(b.elementRef) || a.code.localeCompare(b.code)), design };
}

/** Supply-only propagation; see `recommendDuctSegments`. */
export function recommendSupplyDuctSegments(items: readonly NetworkItem[], options: Omit<DuctNetworkOptions, "airflowTypes"> = {}): DuctNetworkResult {
  return recommendDuctSegments(items, { ...options, airflowTypes: ["supply"] });
}
