import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  mechanicalEditItemSchema,
  planArchitectureLayerSchema,
  storeyLoadsSchema,
} from "../../types";
import {
  validateMechanicalPlan,
  type ValidateOptions,
  type ValidationFinding,
  type ValidationReport,
} from "./mechanical-validator";

/**
 * File-based grading for the agentic plan-editor loop. The editor (a subagent or
 * a headless `claude` process) sees only the artifact JSONs in a run directory
 * and edits `mechanicalEdit2D.json`; this re-grades from those files alone, so
 * the score depends purely on the abstraction the editor was given.
 */

const editItemsSchema = z.array(mechanicalEditItemSchema);

export const evalTaskSchema = z.discriminatedUnion("taskId", [
  z.object({
    taskId: z.literal("T2"),
    targetItemId: z.string(),
    targetSpaceGlobalId: z.string(),
    prompt: z.string(),
  }),
  z.object({
    taskId: z.literal("T3"),
    targetItemId: z.string(),
    prompt: z.string(),
  }),
  z.object({
    taskId: z.literal("T4"),
    targetItemId: z.string(),
    terminalItemIds: z.array(z.string()).min(1),
    cfm: z.number().positive(),
    prompt: z.string(),
  }),
  z.object({
    taskId: z.literal("T5"),
    targetSpaceGlobalId: z.string(),
    terminalItemIds: z.array(z.string()).min(2),
    designCfm: z.number().positive(),
    prompt: z.string(),
  }),
]);

export type EvalTask = z.infer<typeof evalTaskSchema>;

export function readEvalTask(dir: string): EvalTask | null {
  const taskPath = path.join(dir, "eval-task.json");
  if (!existsSync(taskPath)) return null;
  return evalTaskSchema.parse(JSON.parse(readFileSync(taskPath, "utf8")));
}

export function validationOptionsForTask(
  task: EvalTask | null,
): ValidateOptions {
  if (task?.taskId === "T4") {
    return { ductSizingItemIds: [task.targetItemId] };
  }
  if (task?.taskId === "T5") {
    return { terminalBalanceSpaceIds: [task.targetSpaceGlobalId] };
  }
  return {};
}

export function gradeRunDir(dir: string): ValidationReport {
  const architecture = planArchitectureLayerSchema.parse(
    JSON.parse(readFileSync(path.join(dir, "architecture.json"), "utf8")),
  );
  const loads = storeyLoadsSchema.parse(
    JSON.parse(readFileSync(path.join(dir, "loads.json"), "utf8")),
  );
  const editItems = editItemsSchema.parse(
    JSON.parse(readFileSync(path.join(dir, "mechanicalEdit2D.json"), "utf8")),
  );
  const task = readEvalTask(dir);
  return validateMechanicalPlan({
    editItems,
    spaces: architecture.spaces,
    spaceLoads: loads.spaces,
    options: validationOptionsForTask(task),
  });
}

function findingKey(finding: ValidationFinding): string {
  return `${finding.check}|${finding.spaceGlobalId ?? ""}|${finding.itemId ?? ""}`;
}

export type ReportDiff = {
  resolved: ValidationFinding[];
  introduced: ValidationFinding[];
  baselineErrors: number;
  currentErrors: number;
  /** Fewer errors than baseline and no new error introduced. */
  improved: boolean;
};

export type TargetedTaskOutcome = {
  baselineTargetFindings: ValidationFinding[];
  currentTargetFindings: ValidationFinding[];
  passed: boolean;
};

function isTargetFinding(finding: ValidationFinding, task: EvalTask): boolean {
  switch (task.taskId) {
    case "T2":
      return (
        finding.check === "terminal-in-room" &&
        finding.itemId === task.targetItemId
      );
    case "T3":
      return (
        finding.check === "connectivity" && finding.itemId === task.targetItemId
      );
    case "T4":
      return (
        finding.check === "duct-sizing" && finding.itemId === task.targetItemId
      );
    case "T5":
      return (
        finding.check === "terminal-cfm-balance" &&
        finding.spaceGlobalId === task.targetSpaceGlobalId
      );
  }
}

export function gradeTargetedTask(
  task: EvalTask,
  baseline: ValidationReport,
  current: ValidationReport,
  diff: ReportDiff,
): TargetedTaskOutcome {
  const baselineTargetFindings = baseline.findings.filter((finding) =>
    isTargetFinding(finding, task),
  );
  const currentTargetFindings = current.findings.filter((finding) =>
    isTargetFinding(finding, task),
  );
  const introducedErrors = diff.introduced.filter(
    (finding) => finding.severity === "error",
  );
  return {
    baselineTargetFindings,
    currentTargetFindings,
    passed:
      baselineTargetFindings.length > 0 &&
      currentTargetFindings.length === 0 &&
      introducedErrors.length === 0,
  };
}

export function diffReports(
  baseline: ValidationReport,
  current: ValidationReport,
): ReportDiff {
  const baseKeys = new Set(baseline.findings.map(findingKey));
  const curKeys = new Set(current.findings.map(findingKey));
  const resolved = baseline.findings.filter((f) => !curKeys.has(findingKey(f)));
  const introduced = current.findings.filter(
    (f) => !baseKeys.has(findingKey(f)),
  );
  const introducedErrors = introduced.filter(
    (f) => f.severity === "error",
  ).length;
  return {
    resolved,
    introduced,
    baselineErrors: baseline.errorCount,
    currentErrors: current.errorCount,
    improved:
      current.errorCount < baseline.errorCount && introducedErrors === 0,
  };
}
