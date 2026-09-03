#!/usr/bin/env node
// T4 sizing-context experiment: same task, starter, guard, and 7-inch oracle; only the
// context handed to a fresh isolated editor changes. Not published with the package.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureRoot, grade, resultsRoot } from "../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const cli = join(packageRoot, "bin", "mep-benchmark.js");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, value = "true"] = arg.replace(/^--/, "").split("="); return [key, value]; }));
const MODEL = args.model ?? "claude-sonnet-5";
const ATTEMPTS = Number(args.attempts ?? 3);
const CONCURRENCY = Number(args.concurrency ?? 5);
const ONLY = args.only ? new Set(args.only.split(",")) : null;
const WORK = resolve(args.work ?? join(process.env.TMPDIR ?? "/tmp", "mep-t4-context"));
const TIMEOUT_MS = Number(args.timeoutMs ?? 10 * 60 * 1000);
if (!Number.isInteger(ATTEMPTS) || ATTEMPTS < 1) throw new Error(`attempts must be a positive integer, got ${args.attempts}`);

const task = JSON.parse(readFileSync(join(fixtureRoot, "single", "T4", "task.json"), "utf8"));
const starter = JSON.parse(readFileSync(join(fixtureRoot, "single", "T4", "starter.json"), "utf8"));

const base = [
  "You are editing a synthetic HVAC plan.",
  "Read only `task.json` and `candidate.json` in the current directory, and edit only `candidate.json`.",
  "Do not read, list, or search any other file or directory.",
  "",
  `Task: ${task.prompt}`,
  "",
  "Write the full updated plan JSON back to `candidate.json`.",
];
const parameters = [
  "Sizing engine parameters:",
  "- Method: equal friction at a design friction rate of 0.08 in. w.g. per 100 ft.",
  "- Friction rate for a round duct (in. w.g. per 100 ft) = 0.109136 · CFM^1.9 / D^5.02, with D in inches.",
  "- Velocity (fpm) = CFM / ((π/4) · (D/12)^2).",
  "- Recommended maximum velocity for a supply runout: 700 fpm.",
  "- Standard round diameters (in): 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60.",
];
const rule = [
  "- Selection rule: compute the exact diameter that meets the design friction rate; if the velocity cap requires a larger diameter, use that instead; then select the smallest standard diameter that is greater than or equal to that exact diameter.",
];
const apiHint = [
  "The benchmark's sizing engine has this public API (you cannot call it; use it as the specification):",
  "```ts",
  "/** Default low-velocity commercial friction rate, in. w.g. per 100 ft. */",
  "export const DEFAULT_FRICTION_RATE_PER_100FT = 0.08;",
  "export const STANDARD_ROUND_DIAMETERS_IN = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60] as const;",
  "export type DuctRole = \"main\" | \"branch\" | \"runout\";",
  "export type AirflowType = \"supply\" | \"return\" | \"exhaust\" | \"outside-air\";",
  "/** Recommended maximum velocity (fpm) by classified airflow and role; supply = { main: 1300, branch: 900, runout: 700 }. */",
  "export function recommendedMaxVelocityFpm(airflowType: AirflowType, role: DuctRole): number;",
  "export type RoundDuctSize = { cfm: number; exactDiameterIn: number; standardDiameterIn: number; velocityFpm: number; frictionRatePer100ft: number; targetFrictionRatePer100ft: number; governingConstraint: \"friction\" | \"velocity\" };",
  "/** Size a round duct by the equal-friction method using the role-based velocity cap for classified airflow. */",
  "export function sizeDuctForAirflow(input: { cfm: number; airflowType: AirflowType; role: DuctRole; frictionRatePer100ft?: number }): RoundDuctSize;",
  "```",
];
const tool = [
  "The benchmark's sizing engine is available as a command in the current directory:",
  "`./mep-benchmark size <cfm> <airflowType> <role>` prints JSON including `standardDiameterIn`.",
  "Use it to size the segment.",
];
const variants = [
  { id: "V0-control", description: "Original task prompt only (replicates the v0.1.0 condition).", prompt: base, tools: ["Read", "Edit", "Write"] },
  { id: "V1-parameters", description: "Prompt plus friction rate, formulas, velocity cap, and standard sizes; no selection rule.", prompt: [...base, "", ...parameters], tools: ["Read", "Edit", "Write"] },
  { id: "V2-parameters-rule", description: "V1 plus the explicit next-standard-size selection rule.", prompt: [...base, "", ...parameters, ...rule], tools: ["Read", "Edit", "Write"] },
  { id: "V3-api-hint", description: "Prompt plus the engine's public TypeScript API and defaults; no formulas.", prompt: [...base, "", ...apiHint], tools: ["Read", "Edit", "Write"] },
  { id: "V4-tool", description: "Prompt plus a shell wrapper around `mep-benchmark size`; the editor may run it.", prompt: [...base, "", ...tool], tools: ["Read", "Edit", "Write", "Bash"] },
].filter((variant) => !ONLY || ONLY.has(variant.id));

function runClaude(cwd, prompt, tools) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env }; delete env.CLAUDECODE;
    const child = spawn("claude", ["-p", prompt, "--model", MODEL, "--output-format", "json", "--dangerously-skip-permissions", "--no-session-persistence", "--tools", ...tools], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`editor timed out after ${TIMEOUT_MS} ms`)); }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`));
      try { resolvePromise(JSON.parse(stdout)); } catch (error) { reject(new Error(`unparseable claude output: ${error.message}\n${stdout.slice(0, 500)}`)); }
    });
  });
}

async function runTrial(variant, attempt) {
  const dir = join(WORK, `${variant.id}-${attempt}`);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  copyFileSync(join(fixtureRoot, "single", "T4", "task.json"), join(dir, "task.json"));
  writeFileSync(join(dir, "candidate.json"), JSON.stringify(starter));
  if (variant.tools.includes("Bash")) {
    writeFileSync(join(dir, "mep-benchmark"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
    chmodSync(join(dir, "mep-benchmark"), 0o755);
  }
  const started = Date.now();
  const run = await runClaude(dir, variant.prompt.join("\n"), variant.tools);
  if (run.is_error) throw new Error(`editor run failed for ${variant.id}#${attempt}: ${run.result}`);
  const candidate = JSON.parse(readFileSync(join(dir, "candidate.json"), "utf8"));
  const result = grade(task, starter, candidate);
  const chosen = candidate.segments?.find((segment) => segment.id === task.target.segmentId)?.diameterIn ?? null;
  const models = Object.entries(run.modelUsage ?? {}).filter(([, usage]) => (usage.outputTokens ?? 0) > 0).map(([id]) => id);
  console.error(`${variant.id}#${attempt}: ${result.passed ? "PASS" : "FAIL"} diameterIn=${chosen} ${(run.duration_ms / 1000).toFixed(1)}s`);
  return {
    variant: variant.id, attempt, taskId: "T4", passed: result.passed, chosenDiameterIn: chosen,
    finalFindings: [...result.current.errors, ...result.newErrors].map((f) => `${f.check}: ${f.itemId ?? f.spaceId} expected ${f.expected ?? ""} actual ${f.actual ?? ""}`.trim()),
    mutationGuardPassed: result.mutationGuard.passed,
    models, durationSeconds: Math.round(run.duration_ms / 100) / 10, wallSeconds: Math.round((Date.now() - started) / 100) / 10,
    turns: run.num_turns, costUsd: run.total_cost_usd, candidate: `t4-context/candidates/${variant.id}-${attempt}.json`, candidateText: JSON.stringify(candidate),
  };
}

const queue = variants.flatMap((variant) => Array.from({ length: ATTEMPTS }, (_, i) => [variant, i + 1]));
const trials = [];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (queue.length) { const [variant, attempt] = queue.shift(); trials.push(await runTrial(variant, attempt)); } }));
trials.sort((a, b) => a.variant.localeCompare(b.variant) || a.attempt - b.attempt);

const outDir = join(resultsRoot, "t4-context");
mkdirSync(join(outDir, "candidates"), { recursive: true }); mkdirSync(join(outDir, "prompts"), { recursive: true });
for (const trial of trials) { writeFileSync(join(resultsRoot, trial.candidate), trial.candidateText); delete trial.candidateText; }
for (const variant of variants) writeFileSync(join(outDir, "prompts", `${variant.id}.md`), `# ${variant.id}\n\n${variant.description}\n\nTools: ${variant.tools.join(", ")}\n\n\`\`\`\n${variant.prompt.join("\n")}\n\`\`\`\n`);
const byVariant = Object.fromEntries(variants.map((variant) => {
  const own = trials.filter((trial) => trial.variant === variant.id);
  return [variant.id, { description: variant.description, tools: variant.tools, passes: own.filter((t) => t.passed).length, attempts: own.length, chosenDiametersIn: own.map((t) => t.chosenDiameterIn), meanDurationSeconds: Math.round(own.reduce((s, t) => s + t.durationSeconds, 0) / own.length * 10) / 10 }];
}));
const summary = { passes: trials.filter((t) => t.passed).length, attempts: trials.length };
const recorded = {
  benchmarkVersion: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version,
  experiment: "t4-sizing-context", fixtureSet: "single", task: "T4", oracleDiameterIn: 7, date: new Date().toISOString().slice(0, 10),
  agent: { surface: "claude -p (headless, fresh process per attempt, --no-session-persistence)", requestedModel: MODEL, context: "task.json and candidate.json only, plus the variant context in the prompt; no oracle, grader, domain source, repository fixture, or other task access" },
  summary: { ...summary, passRate: Math.round((summary.passes / summary.attempts) * 1000) / 1000 },
  variants: byVariant, trials,
  limitations: [
    `${ATTEMPTS} attempts per variant on one deliberately small synthetic fixture.`,
    "Model identifiers come from the runner's reported usage; durations are the runner's reported wall clock for the editor process.",
    "This result is a capability observation about context, not a reliability, engineering, or code-compliance claim.",
  ],
};
writeFileSync(join(resultsRoot, "t4-context-v1.json"), `${JSON.stringify(recorded, null, 2)}\n`);
console.log(JSON.stringify({ summary: recorded.summary, variants: byVariant }, null, 2));
