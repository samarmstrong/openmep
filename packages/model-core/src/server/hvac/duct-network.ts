import {
  DuctNetworkError,
  recommendSupplyDuctSegments,
  type DuctNetworkErrorCode,
  type DuctNetworkFinding,
  type NetworkItem,
  type RoundDuctSize,
} from "@openmep/hvac-domain";

import type { MechanicalEditItem } from "../../types";

export { DuctNetworkError };
export type { DuctNetworkErrorCode, DuctNetworkFinding };

export type DuctSegmentRecommendation = {
  itemId: string;
  elementRef: string;
  cfm: number;
  terminalItemIds: string[];
  role: "main" | "branch" | "runout";
  size: RoundDuctSize;
  /** Round diameter expressed in the plan's foot-based width units. */
  recommendedWidthFt: number;
};

export type DuctNetworkSizingResult = {
  segments: Map<string, DuctSegmentRecommendation>;
  findings: readonly DuctNetworkFinding[];
};

function toNetworkItem(item: MechanicalEditItem): NetworkItem {
  const base = {
    id: item.id,
    elementRef: item.elementRef,
    airflowType: item.airflowType,
    connectedItemRefs: item.connectedItemIds,
  };
  if (item.editKind === "edge") {
    return { ...base, kind: "segment" };
  }
  if (item.kind === "mech-equipment") {
    return { ...base, kind: "equipment" };
  }
  if (item.kind === "mech-terminal") {
    return { ...base, kind: "terminal", requiredCfm: item.requiredCfm };
  }
  return { ...base, kind: "fitting" };
}

/**
 * Product adapter around the public domain package. Product JSON retains IFC
 * element references and foot-based widths; the public core stays independent
 * of both conventions.
 */
export function recommendDuctSegmentSizes(
  editItems: ReadonlyArray<MechanicalEditItem>,
): DuctNetworkSizingResult {
  const result = recommendSupplyDuctSegments(editItems.map(toNetworkItem));
  return {
    findings: result.findings,
    segments: new Map(
      result.segments.map((segment) => [
        segment.itemId,
        {
          ...segment,
          terminalItemIds: [...segment.terminalItemIds],
          recommendedWidthFt: segment.size.standardDiameterIn / 12,
        },
      ]),
    ),
  };
}
