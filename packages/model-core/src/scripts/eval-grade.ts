import { readFileSync } from "node:fs";
import path from "node:path";

import {
  gradeRunDir,
  diffReports,
  gradeTargetedTask,
  readEvalTask,
} from "../server/hvac/eval";
import type { ValidationReport } from "../server/hvac";

/**
 * Grade an edited run directory against its baseline. The editor (subagent or
 * headless `claude`) has rewritten `mechanicalEdit2D.json`; this re-runs the
 * deterministic checks and reports what was resolved / introduced.
 *
 *   tsx packages/model-core/src/scripts/eval-grade.ts <run-dir>
 *
 * With eval-task.json, exits 0 when the targeted task finding is resolved with
 * no new errors. Without it, preserves the generic fewer-errors behavior.
 */

function main(): void {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: tsx eval-grade.ts <run-dir>");
    process.exit(2);
  }

  const current = gradeRunDir(dir);
  const baseline: ValidationReport = JSON.parse(
    readFileSync(path.join(dir, "baseline.json"), "utf8"),
  );
  const diff = diffReports(baseline, current);
  const task = readEvalTask(dir);
  const targeted = task
    ? gradeTargetedTask(task, baseline, current, diff)
    : null;

  console.log(`run: ${dir}`);
  console.log(
    `baseline ${diff.baselineErrors}E  →  current ${diff.currentErrors}E ` +
      `(${current.warningCount}W)`,
  );
  if (diff.resolved.length > 0) {
    console.log(`\nresolved (${diff.resolved.length}):`);
    for (const f of diff.resolved) {
      console.log(`  ✓ [${f.check}] ${f.message}`);
    }
  }
  if (diff.introduced.length > 0) {
    console.log(`\nintroduced (${diff.introduced.length}):`);
    for (const f of diff.introduced) {
      console.log(`  ✗ [${f.severity}/${f.check}] ${f.message}`);
    }
  }
  const passed = targeted?.passed ?? diff.improved;
  if (targeted) {
    console.log(
      `\ntarget ${task!.taskId}: ${targeted.baselineTargetFindings.length} finding(s) → ` +
        `${targeted.currentTargetFindings.length}`,
    );
  }
  console.log(`\n${passed ? "PASS — target resolved" : "NO IMPROVEMENT"}`);
  process.exit(passed ? 0 : 1);
}

main();
