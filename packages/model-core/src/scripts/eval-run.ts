import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { mechanicalEditItemSchema, type MechanicalEditItem } from "../types";
import type { ValidationReport } from "../server/hvac";
import { diffReports, gradeRunDir, gradeTargetedTask, readEvalTask, type EvalTask } from "../server/hvac/eval";

/**
 * Run fresh, isolated headless `claude` editors against prepared real-fixture
 * tasks and grade every attempt deterministically.
 *
 *   npm run eval:run -- <prepared-root> [--tasks T2,T3,T4,T5] [--attempts 3]
 *     [--concurrency 4] [--model claude-sonnet-5] [--out eval-runs/runs/<date>.json]
 *     [--work <dir>] [--timeout-ms 900000] [--fixture <label>]
 *
 * `--fixture` labels the recorded run's provenance; it defaults to the prepared
 * root's path relative to the repo (e.g. `eval-runs/wbdg_office/Level_1`),
 * which is the `--model-id`/storey directory `eval-materialize` produced it from.
 *
 * Each editor sees only the four product-facing JSON files and a shell wrapper
 * for `mep-benchmark size`; hidden baseline/task metadata is copied in only
 * after the editor exits, for grading.
 */

const PRODUCT_FILES = ["architecture.json", "loads.json", "mechanicalVisual2D.json", "mechanicalEdit2D.json"] as const;
const HIDDEN_FILES = ["baseline.json", "eval-task.json"] as const;
const TASK_IDS = ["T2", "T3", "T4", "T5"] as const;
const TOOLS = ["Read", "Edit", "Write", "Bash"];
const editItemsSchema = z.array(mechanicalEditItemSchema);
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const sizingCli = path.join(repoRoot, "packages/agent-benchmark/bin/mep-benchmark.js");

function option(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function positiveInteger(flag: string, fallback: number): number {
  const raw = option(flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer, got ${raw}`);
  return value;
}

const preparedRoot = process.argv[2];
if (!preparedRoot || preparedRoot.startsWith("--")) throw new Error("usage: eval-run.ts <prepared-root> [--tasks ...] [--attempts N]");
const tasks = (option("--tasks")?.split(",") ?? [...TASK_IDS]) as Array<(typeof TASK_IDS)[number]>;
for (const id of tasks) if (!TASK_IDS.includes(id)) throw new Error(`unknown task ${id}`);
const attempts = positiveInteger("--attempts", 3);
const concurrency = positiveInteger("--concurrency", 4);
const timeoutMs = positiveInteger("--timeout-ms", 15 * 60 * 1000);
const model = option("--model") ?? "claude-sonnet-5";
const date = new Date().toISOString().slice(0, 10);
const outPath = path.resolve(option("--out") ?? `eval-runs/runs/${date}-headless.json`);
const workRoot = path.resolve(option("--work") ?? path.join(process.env.TMPDIR ?? "/tmp", "mep-eval-run"));
const fixture = option("--fixture") ?? (path.relative(repoRoot, path.resolve(preparedRoot)) || path.resolve(preparedRoot));

const instructions = (task: EvalTask): string => [
  "You are editing one storey of a mechanical HVAC plan. Read only these files in the current directory and edit only `mechanicalEdit2D.json`. Do not read, list, or search any other file or directory.",
  "- `architecture.json` — room polygons + labels (context)",
  "- `loads.json` — each room's required `designCfm` (context)",
  "- `mechanicalVisual2D.json` — read-only geometry overlay (context)",
  "- `mechanicalEdit2D.json` — the editable ducts/terminals/equipment (EDIT THIS)",
  "",
  "Editable items are an array. A supply terminal (node): `{ id, visualRef, elementRef, editKind:\"node\", kind:\"mech-terminal\", position:[x,y], size:[w,h], rotation, airflowType:\"supply\", connectedItemIds:[elementRef...], spaceGlobalId, spaceDesignCfm, requiredCfm }`. A duct segment (edge): `{ id, visualRef, elementRef, editKind:\"edge\", kind:\"mech-segment\", path:[[x,y],...], width, airflowType, connectedItemIds:[elementRef...] }`. Positions and `width` are in feet in the storey frame; for round duct `width` is the diameter in feet. A terminal must sit inside its room's polygon. `connectedItemIds` reference other items' `elementRef` values.",
  "",
  `Task: ${task.prompt}`,
  "",
  "The deterministic sizing engine is available as a command in the current directory: `./mep-benchmark size <cfm> <airflowType> <role>` prints JSON including `standardDiameterIn` (divide by 12 for `width` in feet). Use it whenever a duct must be sized.",
  "",
  "Write the full updated array back to `mechanicalEdit2D.json`.",
].join("\n");

type ClaudeResult = { is_error?: boolean; result?: string; duration_ms: number; num_turns: number; total_cost_usd: number; modelUsage?: Record<string, { outputTokens?: number }> };

function runClaude(cwd: string, prompt: string): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.CLAUDECODE;
    const child = spawn("claude", ["-p", prompt, "--model", model, "--output-format", "json", "--dangerously-skip-permissions", "--no-session-persistence", "--tools", ...TOOLS], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`editor timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`));
      const parsed = JSON.parse(stdout) as ClaudeResult;
      if (parsed.is_error) return reject(new Error(`editor run failed: ${parsed.result}`));
      resolve(parsed);
    });
  });
}

type ItemChange = { id: string; before: MechanicalEditItem | null; after: MechanicalEditItem | null };
function diffItems(before: MechanicalEditItem[], after: MechanicalEditItem[]): ItemChange[] {
  const byId = (items: MechanicalEditItem[]) => new Map(items.map((item) => [item.id, item]));
  const a = byId(before); const b = byId(after); const changes: ItemChange[] = [];
  for (const [id, item] of a) { const next = b.get(id) ?? null; if (JSON.stringify(item) !== JSON.stringify(next)) changes.push({ id, before: item, after: next }); }
  for (const [id, item] of b) if (!a.has(id)) changes.push({ id, before: null, after: item });
  return changes;
}

async function runTrial(taskId: string, attempt: number) {
  const source = path.join(path.resolve(preparedRoot), taskId);
  const task = readEvalTask(source);
  if (!task) throw new Error(`${source} has no eval-task.json`);
  const dir = path.join(workRoot, `${taskId}-${attempt}`);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  for (const file of PRODUCT_FILES) copyFileSync(path.join(source, file), path.join(dir, file));
  writeFileSync(path.join(dir, "mep-benchmark"), `#!/bin/sh\nexec "${process.execPath}" "${sizingCli}" "$@"\n`); chmodSync(path.join(dir, "mep-benchmark"), 0o755);
  const run = await runClaude(dir, instructions(task));
  for (const file of HIDDEN_FILES) copyFileSync(path.join(source, file), path.join(dir, file));
  const baseline: ValidationReport = JSON.parse(readFileSync(path.join(source, "baseline.json"), "utf8"));
  const current = gradeRunDir(dir);
  const diff = diffReports(baseline, current);
  const targeted = gradeTargetedTask(task, baseline, current, diff);
  const editedText = readFileSync(path.join(dir, "mechanicalEdit2D.json"), "utf8");
  const changes = diffItems(editItemsSchema.parse(JSON.parse(readFileSync(path.join(source, "mechanicalEdit2D.json"), "utf8"))), editItemsSchema.parse(JSON.parse(editedText)));
  console.error(`${taskId}#${attempt}: ${targeted.passed ? "PASS" : "FAIL"} ${(run.duration_ms / 1000).toFixed(1)}s ${diff.baselineErrors}E→${diff.currentErrors}E introduced=${diff.introduced.length} changedItems=${changes.length}`);
  return {
    taskId, attempt, passed: targeted.passed,
    baselineTargetFindings: targeted.baselineTargetFindings.map((f) => f.message), currentTargetFindings: targeted.currentTargetFindings.map((f) => f.message),
    introduced: diff.introduced.map((f) => `${f.severity}/${f.check}: ${f.message}`), baselineErrors: diff.baselineErrors, currentErrors: diff.currentErrors,
    models: Object.entries(run.modelUsage ?? {}).filter(([, usage]) => (usage.outputTokens ?? 0) > 0).map(([id]) => id),
    durationSeconds: Math.round(run.duration_ms / 100) / 10, turns: run.num_turns, costUsd: run.total_cost_usd,
    candidateSha256: createHash("sha256").update(editedText).digest("hex"), workDir: dir, changes,
  };
}

async function main(): Promise<void> {
  const queue = tasks.flatMap((taskId) => Array.from({ length: attempts }, (_, i) => [taskId, i + 1] as const));
  const trials: Awaited<ReturnType<typeof runTrial>>[] = [];
  await Promise.all(Array.from({ length: concurrency }, async () => { while (queue.length) { const [taskId, attempt] = queue.shift()!; trials.push(await runTrial(taskId, attempt)); } }));
  trials.sort((a, b) => TASK_IDS.indexOf(a.taskId as never) - TASK_IDS.indexOf(b.taskId as never) || a.attempt - b.attempt);
  const tally = (own: typeof trials) => ({ passes: own.filter((t) => t.passed).length, attempts: own.length, meanDurationSeconds: Math.round((own.reduce((s, t) => s + t.durationSeconds, 0) / own.length) * 10) / 10 });
  const recorded = {
    date, preparedRoot: path.resolve(preparedRoot), fixture,
    agent: { surface: "claude -p (headless, fresh process per attempt, --no-session-persistence)", requestedModel: model, tools: TOOLS, context: "the four product-facing JSON files plus a shell wrapper for `mep-benchmark size`; no baseline, task metadata, validator source, repository, or IFC access" },
    summary: tally(trials), byTask: Object.fromEntries(tasks.map((id) => [id, tally(trials.filter((t) => t.taskId === id))])), trials,
  };
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(JSON.stringify({ out: outPath, summary: recorded.summary, byTask: recorded.byTask }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
