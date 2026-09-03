import type { MechanicalEditItem, PlanSpace, SpaceLoad } from "../../types";
import { pointInPolygon } from "./geometry-2d";
import { recommendDuctSegmentSizes } from "./duct-network";

/**
 * Deterministic grader for an edited mechanical plan. This is what makes the
 * agentic plan-editor loop objective: an LLM edit is correct iff it satisfies
 * these checks, no human judgment required.
 *
 * Checks (all keyed off the CFM-grounded edit layer + loads):
 *  - cfm-conservation: each space's supply terminals deliver its design CFM.
 *  - terminal-in-room: a terminal's declared room actually contains its point.
 *  - connectivity: each supply terminal reaches air-handling equipment, or a
 *    duct leaving the storey, through the network (connectedItemIds).
 * Optional targeted checks grade propagated duct width and equal terminal-CFM
 * balance without destabilizing existing whole-plan baselines.
 */

type EditNode = Extract<MechanicalEditItem, { editKind: "node" }>;

function isNode(item: MechanicalEditItem): item is EditNode {
  return item.editKind === "node";
}

export type ValidationCheck =
  | "cfm-conservation"
  | "terminal-in-room"
  | "connectivity"
  | "duct-sizing"
  | "terminal-cfm-balance";

export type ValidationFinding = {
  check: ValidationCheck;
  severity: "error" | "warning";
  message: string;
  spaceGlobalId?: string;
  itemId?: string;
};

export type ValidationReport = {
  findings: ValidationFinding[];
  errorCount: number;
  warningCount: number;
  /** True when there are no errors (warnings are allowed). */
  passed: boolean;
};

export type ValidateOptions = {
  /** Allowed fractional deviation of supplied vs required CFM (default 0.05). */
  cfmTolerance?: number;
  /** Minimum absolute CFM slack so tiny rooms aren't over-constrained (default 25). */
  cfmAbsoluteToleranceCfm?: number;
  /** Edge item ids whose widths should be checked against propagated CFM. */
  ductSizingItemIds?: ReadonlyArray<string>;
  /** Allowed absolute width difference in plan feet (default 1/24 = 0.5 in). */
  ductWidthToleranceFt?: number;
  /** Space ids whose supply-terminal CFM should be checked for an equal split. */
  terminalBalanceSpaceIds?: ReadonlyArray<string>;
  /** Allowed per-terminal deviation from the equal split (default 1 CFM). */
  terminalBalanceToleranceCfm?: number;
};

export function validateMechanicalPlan(input: {
  editItems: ReadonlyArray<MechanicalEditItem>;
  spaces: ReadonlyArray<PlanSpace>;
  spaceLoads: ReadonlyArray<SpaceLoad>;
  options?: ValidateOptions;
}): ValidationReport {
  const findings: ValidationFinding[] = [];
  const cfmTolerance = input.options?.cfmTolerance ?? 0.05;
  const cfmAbsolute = input.options?.cfmAbsoluteToleranceCfm ?? 25;

  const supplyTerminals = input.editItems.filter(
    (item): item is EditNode =>
      item.editKind === "node" &&
      item.kind === "mech-terminal" &&
      item.airflowType === "supply",
  );
  const spacesById = new Map(
    input.spaces.map((space) => [space.globalId, space]),
  );

  // --- Check 1: CFM conservation per space -----------------------------------
  const suppliedBySpace = new Map<string, number>();
  for (const terminal of supplyTerminals) {
    if (terminal.spaceGlobalId && terminal.requiredCfm != null) {
      suppliedBySpace.set(
        terminal.spaceGlobalId,
        (suppliedBySpace.get(terminal.spaceGlobalId) ?? 0) +
          terminal.requiredCfm,
      );
    }
  }
  for (const load of input.spaceLoads) {
    if (!(load.designCfm > 0)) continue;
    const supplied = suppliedBySpace.get(load.spaceGlobalId) ?? 0;
    const tolerance = Math.max(cfmAbsolute, load.designCfm * cfmTolerance);
    if (supplied <= 0) {
      findings.push({
        check: "cfm-conservation",
        severity: "error",
        spaceGlobalId: load.spaceGlobalId,
        message: `space requires ${load.designCfm.toFixed(
          0,
        )} CFM supply but no supply terminal delivers it`,
      });
    } else if (Math.abs(supplied - load.designCfm) > tolerance) {
      findings.push({
        check: "cfm-conservation",
        severity: "error",
        spaceGlobalId: load.spaceGlobalId,
        message: `supplied ${supplied.toFixed(0)} CFM ≠ required ${load.designCfm.toFixed(
          0,
        )} CFM (±${tolerance.toFixed(0)})`,
      });
    }
  }

  // --- Check 2: terminal-in-room ---------------------------------------------
  for (const terminal of supplyTerminals) {
    if (!terminal.spaceGlobalId) continue;
    const space = spacesById.get(terminal.spaceGlobalId);
    if (!space) {
      findings.push({
        check: "terminal-in-room",
        severity: "error",
        itemId: terminal.id,
        spaceGlobalId: terminal.spaceGlobalId,
        message: `terminal references space ${terminal.spaceGlobalId} which is not in the plan`,
      });
      continue;
    }
    const inside = space.polygons.some((polygon) =>
      pointInPolygon(terminal.position, polygon),
    );
    if (!inside) {
      findings.push({
        check: "terminal-in-room",
        severity: "error",
        itemId: terminal.id,
        spaceGlobalId: terminal.spaceGlobalId,
        message: `terminal position [${terminal.position[0].toFixed(
          1,
        )}, ${terminal.position[1].toFixed(1)}] is outside its declared room`,
      });
    }
  }

  // --- Check 3: connectivity to supply equipment -----------------------------
  // connectedItemIds reference elementRef globalIds (IfcRelConnectsPorts).
  const itemByElementRef = new Map<string, MechanicalEditItem>();
  for (const item of input.editItems) {
    itemByElementRef.set(item.elementRef, item);
  }
  const reachesEquipment = (start: EditNode): boolean => {
    const seen = new Set<string>([start.elementRef]);
    const queue = [...start.connectedItemIds];
    while (queue.length > 0) {
      const ref = queue.shift()!;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const item = itemByElementRef.get(ref);
      // A reference outside this storey's plan is a riser or trunk continuing
      // on another level; the network leaves the storey, which is as far as a
      // per-storey check can follow.
      if (!item) return true;
      if (isNode(item) && item.kind === "mech-equipment") return true;
      for (const next of item.connectedItemIds) {
        if (!seen.has(next)) queue.push(next);
      }
    }
    return false;
  };
  for (const terminal of supplyTerminals) {
    if (terminal.connectedItemIds.length === 0) {
      findings.push({
        check: "connectivity",
        severity: "warning",
        itemId: terminal.id,
        message: "supply terminal has no duct connections",
      });
    } else if (!reachesEquipment(terminal)) {
      findings.push({
        check: "connectivity",
        severity: "warning",
        itemId: terminal.id,
        message:
          "supply terminal is not connected to any air-handling equipment or duct leaving the storey",
      });
    }
  }

  // --- Optional targeted check 4: propagated duct sizing --------------------
  const ductSizingTargets = new Set(input.options?.ductSizingItemIds ?? []);
  if (ductSizingTargets.size > 0) {
    const recommendations = recommendDuctSegmentSizes(input.editItems).segments;
    const widthTolerance = input.options?.ductWidthToleranceFt ?? 1 / 24;
    const editItemById = new Map(
      input.editItems.map((item) => [item.id, item]),
    );
    for (const itemId of Array.from(ductSizingTargets).sort()) {
      const item = editItemById.get(itemId);
      const recommendation = recommendations.get(itemId);
      if (!item || item.editKind !== "edge" || item.kind !== "mech-segment") {
        findings.push({
          check: "duct-sizing",
          severity: "error",
          itemId,
          message: `duct-sizing target ${itemId} is not a mechanical segment`,
        });
        continue;
      }
      if (!recommendation) {
        findings.push({
          check: "duct-sizing",
          severity: "error",
          itemId,
          message: `duct segment has no propagated terminal CFM path to equipment`,
        });
        continue;
      }
      if (
        item.width == null ||
        Math.abs(item.width - recommendation.recommendedWidthFt) >
          widthTolerance
      ) {
        findings.push({
          check: "duct-sizing",
          severity: "error",
          itemId,
          message:
            `duct width ${item.width == null ? "null" : `${(item.width * 12).toFixed(1)} in`} ≠ ` +
            `recommended ${recommendation.size.standardDiameterIn} in for ` +
            `${recommendation.cfm.toFixed(0)} CFM (${recommendation.role}, ±${(
              widthTolerance * 12
            ).toFixed(1)} in)`,
        });
      }
    }
  }

  // --- Optional targeted check 5: equal terminal CFM split ------------------
  const balanceTargets = new Set(input.options?.terminalBalanceSpaceIds ?? []);
  const balanceTolerance = input.options?.terminalBalanceToleranceCfm ?? 1;
  for (const spaceGlobalId of Array.from(balanceTargets).sort()) {
    const load = input.spaceLoads.find(
      (candidate) => candidate.spaceGlobalId === spaceGlobalId,
    );
    const terminals = supplyTerminals.filter(
      (terminal) => terminal.spaceGlobalId === spaceGlobalId,
    );
    if (!load || terminals.length === 0) {
      findings.push({
        check: "terminal-cfm-balance",
        severity: "error",
        spaceGlobalId,
        message: `cannot balance ${spaceGlobalId}: design load or supply terminals are missing`,
      });
      continue;
    }
    const expectedCfm = load.designCfm / terminals.length;
    if (
      terminals.some(
        (terminal) =>
          terminal.requiredCfm == null ||
          Math.abs(terminal.requiredCfm - expectedCfm) > balanceTolerance,
      )
    ) {
      findings.push({
        check: "terminal-cfm-balance",
        severity: "error",
        spaceGlobalId,
        message: `${terminals.length} supply terminals must each deliver ${expectedCfm.toFixed(
          1,
        )} CFM (±${balanceTolerance.toFixed(1)})`,
      });
    }
  }

  const errorCount = findings.filter((f) => f.severity === "error").length;
  return {
    findings,
    errorCount,
    warningCount: findings.length - errorCount,
    passed: errorCount === 0,
  };
}
