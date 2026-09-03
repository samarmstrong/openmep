import type { MechanicalEditItem, PlanSpace, Point2D, SpaceLoad } from "../../types";
import { pointInPolygon, polygonOuterArea } from "./geometry-2d";

/**
 * Grounds the editable mechanical plan in the load calc: each supply terminal is
 * located in its owning space (room) by point-in-polygon, and the space's design
 * CFM is denormalized onto the terminal — split equally across the space's supply
 * terminals. This is what lets an LLM (or the duct-sizing primitive) reason
 * "this diffuser must deliver N CFM, so its runout is sized thus" without joining
 * the loads layer by hand.
 *
 * Equal distribution is the documented first-pass balance, not a silent default:
 * rebalancing across diffusers is a downstream edit the agent can make.
 */

export type TerminalCfmAssignment = {
  /** Edit items with supply terminals enriched (other items returned as-is). */
  editItems: MechanicalEditItem[];
  /** Supply terminals located inside a space and given a CFM target. */
  assignedSupplyTerminals: number;
  /** Supply terminals outside every classified space (no CFM target). */
  unassignedSupplyTerminals: number;
  /** Spaces that require supply CFM but carry no supply terminal in the plan. */
  spacesNeedingSupplyWithNoTerminal: number;
  diagnostics: string[];
};

/**
 * Assigns `spaceGlobalId`, `spaceDesignCfm`, and `requiredCfm` to supply terminal
 * nodes. The smallest containing polygon wins when spaces overlap (most specific
 * room). Returns coverage counts so the caller can fail loud / surface gaps.
 */
export function assignTerminalCfm(
  editItems: ReadonlyArray<MechanicalEditItem>,
  spaces: ReadonlyArray<PlanSpace>,
  spaceLoads: ReadonlyArray<SpaceLoad>
): TerminalCfmAssignment {
  const designCfmBySpace = new Map<string, number>();
  for (const load of spaceLoads) {
    designCfmBySpace.set(load.spaceGlobalId, load.designCfm);
  }

  const locate = (position: Point2D): string | null => {
    let best: { id: string; area: number } | null = null;
    for (const space of spaces) {
      for (const polygon of space.polygons) {
        if (pointInPolygon(position, polygon)) {
          const area = polygonOuterArea(polygon);
          if (!best || area < best.area) {
            best = { id: space.globalId, area };
          }
          break;
        }
      }
    }
    return best?.id ?? null;
  };

  // First pass: resolve room ownership for every supply terminal and group them
  // by space so each space's CFM can be split across its terminals.
  const ownerByItemId = new Map<string, string | null>();
  const supplyTerminalIdsBySpace = new Map<string, string[]>();
  for (const item of editItems) {
    if (item.editKind !== "node" || item.kind !== "mech-terminal") continue;
    if (item.airflowType !== "supply") continue;
    const owner = locate(item.position);
    ownerByItemId.set(item.id, owner);
    if (owner) {
      const bucket = supplyTerminalIdsBySpace.get(owner) ?? [];
      bucket.push(item.id);
      supplyTerminalIdsBySpace.set(owner, bucket);
    }
  }

  // Second pass: write CFM targets onto the supply terminals.
  let assignedSupplyTerminals = 0;
  let unassignedSupplyTerminals = 0;
  const enriched: MechanicalEditItem[] = editItems.map((item) => {
    if (
      item.editKind !== "node" ||
      item.kind !== "mech-terminal" ||
      item.airflowType !== "supply"
    ) {
      return item;
    }
    const owner = ownerByItemId.get(item.id) ?? null;
    if (!owner) {
      unassignedSupplyTerminals += 1;
      return { ...item, spaceGlobalId: null, spaceDesignCfm: null, requiredCfm: null };
    }
    assignedSupplyTerminals += 1;
    const total = designCfmBySpace.get(owner);
    const siblings = supplyTerminalIdsBySpace.get(owner)?.length ?? 1;
    return {
      ...item,
      spaceGlobalId: owner,
      spaceDesignCfm: total ?? null,
      requiredCfm: total === undefined ? null : total / siblings
    };
  });

  let spacesNeedingSupplyWithNoTerminal = 0;
  for (const [spaceId, cfm] of designCfmBySpace) {
    if (cfm > 0 && !supplyTerminalIdsBySpace.get(spaceId)?.length) {
      spacesNeedingSupplyWithNoTerminal += 1;
    }
  }

  const diagnostics: string[] = [];
  if (unassignedSupplyTerminals > 0) {
    diagnostics.push(
      `${unassignedSupplyTerminals} supply terminal(s) sit outside every classified space; no CFM target assigned`
    );
  }
  if (spacesNeedingSupplyWithNoTerminal > 0) {
    diagnostics.push(
      `${spacesNeedingSupplyWithNoTerminal} space(s) require supply CFM but have no supply terminal in the plan`
    );
  }

  return {
    editItems: enriched,
    assignedSupplyTerminals,
    unassignedSupplyTerminals,
    spacesNeedingSupplyWithNoTerminal,
    diagnostics
  };
}
