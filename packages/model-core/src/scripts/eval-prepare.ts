import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  mechanicalEditItemSchema,
  planArchitectureLayerSchema,
  storeyLoadsSchema,
  type MechanicalEditItem,
  type MechanicalEditNodeItem,
} from "../types";
import {
  recommendDuctSegmentSizes,
  validateMechanicalPlan,
} from "../server/hvac";
import { type EvalTask, validationOptionsForTask } from "../server/hvac/eval";

/**
 * Create one deterministic, independently gradable fixture for each remaining
 * editor task. The output directories contain the same four product-facing
 * JSON files as materialization plus hidden baseline/task metadata for grading.
 *
 *   npm run eval:prepare -- <materialized-storey-dir> <out-root>
 */
const editItemsSchema = z.array(mechanicalEditItemSchema);

function requiredArg(index: number, usage: string): string {
  const value = process.argv[index];
  if (!value) throw new Error(`usage: ${usage}`);
  return value;
}

function replaceItem(
  items: MechanicalEditItem[],
  itemId: string,
  update: (item: MechanicalEditItem) => MechanicalEditItem,
): MechanicalEditItem[] {
  let replaced = false;
  const result = items.map((item) => {
    if (item.id !== itemId) return item;
    replaced = true;
    return update(item);
  });
  if (!replaced)
    throw new Error(`Mechanical edit item ${itemId} was not found.`);
  return result;
}

function supplyTerminals(
  items: MechanicalEditItem[],
): MechanicalEditNodeItem[] {
  return items.filter(
    (item): item is MechanicalEditNodeItem =>
      item.editKind === "node" &&
      item.kind === "mech-terminal" &&
      item.airflowType === "supply" &&
      item.spaceGlobalId !== null &&
      item.requiredCfm !== null &&
      item.requiredCfm > 0,
  );
}

async function main(): Promise<void> {
  const usage = "tsx eval-prepare.ts <materialized-storey-dir> <out-root>";
  const sourceDir = path.resolve(requiredArg(2, usage));
  const outRoot = path.resolve(requiredArg(3, usage));
  const [architectureText, loadsText, visualText, editText] = await Promise.all(
    [
      readFile(path.join(sourceDir, "architecture.json"), "utf8"),
      readFile(path.join(sourceDir, "loads.json"), "utf8"),
      readFile(path.join(sourceDir, "mechanicalVisual2D.json"), "utf8"),
      readFile(path.join(sourceDir, "mechanicalEdit2D.json"), "utf8"),
    ],
  );
  const architecture = planArchitectureLayerSchema.parse(
    JSON.parse(architectureText),
  );
  const loads = storeyLoadsSchema.parse(JSON.parse(loadsText));
  const sourceItems = editItemsSchema.parse(JSON.parse(editText));
  const terminals = supplyTerminals(sourceItems);
  if (terminals.length === 0)
    throw new Error("No CFM-bearing supply terminals found.");

  const tasks: Array<{ task: EvalTask; items: MechanicalEditItem[] }> = [];

  const misplaced = terminals.find((terminal) =>
    architecture.spaces.some(
      (space) => space.globalId === terminal.spaceGlobalId,
    ),
  );
  if (!misplaced)
    throw new Error(
      "No supply terminal with a matching architecture space found.",
    );
  const misplacedSpace = architecture.spaces.find(
    (space) => space.globalId === misplaced.spaceGlobalId,
  )!;
  const t2Items = replaceItem(
    sourceItems,
    misplaced.id,
    (item) =>
      ({
        ...item,
        position: [
          misplacedSpace.bounds.max[0] + 10,
          misplacedSpace.bounds.max[1] + 10,
        ],
      }) as MechanicalEditItem,
  );
  tasks.push({
    task: {
      taskId: "T2",
      targetItemId: misplaced.id,
      targetSpaceGlobalId: misplacedSpace.globalId,
      prompt:
        `T2 — Misplaced diffuser. Supply terminal ${misplaced.id} declares room ` +
        `${misplacedSpace.globalId} but its position is outside that room. Move only this ` +
        `terminal inside the room polygon. Preserve its ids, CFM fields, and connections.`,
    },
    items: t2Items,
  });

  const baseReport = validateMechanicalPlan({
    editItems: sourceItems,
    spaces: architecture.spaces,
    spaceLoads: loads.spaces,
  });
  let orphan = baseReport.findings.find(
    (finding) => finding.check === "connectivity" && finding.itemId,
  );
  let t3Items = sourceItems;
  if (!orphan?.itemId) {
    const target = terminals[0];
    t3Items = replaceItem(
      sourceItems,
      target.id,
      (item) =>
        ({
          ...item,
          connectedItemIds: [],
        }) as MechanicalEditItem,
    );
    orphan = {
      check: "connectivity",
      severity: "warning",
      itemId: target.id,
      message: "prepared orphan terminal",
    };
  }
  tasks.push({
    task: {
      taskId: "T3",
      targetItemId: orphan.itemId!,
      prompt:
        `T3 — Orphan diffuser. Supply terminal ${orphan.itemId} has no duct path to ` +
        `mechanical supply equipment. Connect it by updating connectedItemIds and, if ` +
        `needed, adding the minimum mech-segment/fitting items. Connections use elementRef values.`,
    },
    items: t3Items,
  });

  const network = recommendDuctSegmentSizes(sourceItems);
  const runout = Array.from(network.segments.values()).find(
    (segment) => segment.role === "runout",
  );
  if (!runout)
    throw new Error("No CFM-bearing runout segment could be resolved.");
  const t4Items = replaceItem(
    sourceItems,
    runout.itemId,
    (item) =>
      ({
        ...item,
        width: runout.recommendedWidthFt / 2,
      }) as MechanicalEditItem,
  );
  tasks.push({
    task: {
      taskId: "T4",
      targetItemId: runout.itemId,
      terminalItemIds: runout.terminalItemIds,
      cfm: runout.cfm,
      prompt:
        `T4 — Size a runout. Segment ${runout.itemId} carries ${runout.cfm.toFixed(1)} CFM ` +
        `to terminal(s) ${runout.terminalItemIds.join(", ")}. Set width (feet) to the next ` +
        `standard round-duct diameter that satisfies 0.08 in. w.g./100 ft and ≤700 fpm. ` +
        `Use Δp=0.109136·Q^1.9/D^5.02 with Q in CFM and D in inches.`,
    },
    items: t4Items,
  });

  const terminalsBySpace = new Map<string, MechanicalEditNodeItem[]>();
  for (const terminal of terminals) {
    const group = terminalsBySpace.get(terminal.spaceGlobalId!) ?? [];
    group.push(terminal);
    terminalsBySpace.set(terminal.spaceGlobalId!, group);
  }
  const balanceEntry = Array.from(terminalsBySpace).find(
    ([spaceId, group]) =>
      group.length >= 2 &&
      loads.spaces.some((load) => load.spaceGlobalId === spaceId),
  );
  if (!balanceEntry)
    throw new Error("No room with at least two supply terminals found.");
  const [balanceSpaceId, balanceTerminals] = balanceEntry;
  const balanceLoad = loads.spaces.find(
    (load) => load.spaceGlobalId === balanceSpaceId,
  )!;
  const expectedCfm = balanceLoad.designCfm / balanceTerminals.length;
  const changedCfm = new Map([
    [balanceTerminals[0].id, expectedCfm * 0.5],
    [balanceTerminals[1].id, expectedCfm * 1.5],
  ]);
  const t5Items = sourceItems.map((item) =>
    changedCfm.has(item.id)
      ? { ...item, requiredCfm: changedCfm.get(item.id)! }
      : item,
  ) as MechanicalEditItem[];
  tasks.push({
    task: {
      taskId: "T5",
      targetSpaceGlobalId: balanceSpaceId,
      terminalItemIds: balanceTerminals.map((terminal) => terminal.id),
      designCfm: balanceLoad.designCfm,
      prompt:
        `T5 — Rebalance room ${balanceSpaceId}. Its ${balanceTerminals.length} supply ` +
        `terminals (${balanceTerminals.map((terminal) => terminal.id).join(", ")}) must ` +
        `have equal requiredCfm values summing to ${balanceLoad.designCfm.toFixed(1)} CFM. ` +
        `Change only their requiredCfm fields.`,
    },
    items: t5Items,
  });

  for (const { task, items } of tasks) {
    const dir = path.join(outRoot, task.taskId);
    await mkdir(dir, { recursive: true });
    const report = validateMechanicalPlan({
      editItems: items,
      spaces: architecture.spaces,
      spaceLoads: loads.spaces,
      options: validationOptionsForTask(task),
    });
    await Promise.all([
      writeFile(path.join(dir, "architecture.json"), architectureText),
      writeFile(path.join(dir, "loads.json"), loadsText),
      writeFile(path.join(dir, "mechanicalVisual2D.json"), visualText),
      writeFile(
        path.join(dir, "mechanicalEdit2D.json"),
        JSON.stringify(items, null, 2),
      ),
      writeFile(
        path.join(dir, "mechanicalEdit2D.baseline.json"),
        JSON.stringify(items, null, 2),
      ),
      writeFile(
        path.join(dir, "baseline.json"),
        JSON.stringify(report, null, 2),
      ),
      writeFile(
        path.join(dir, "eval-task.json"),
        JSON.stringify(task, null, 2),
      ),
    ]);
    console.log(`${task.taskId}\t${dir}\t${task.prompt}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
