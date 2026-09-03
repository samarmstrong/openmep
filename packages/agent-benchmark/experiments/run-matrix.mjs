#!/usr/bin/env node
// Graded matrix over one fixture set: every task × every prompt form × N fresh isolated editors.
// The editor sees only task.json (with just the selected prompt) and candidate.json, plus the sizing tool.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BenchmarkInputError, TASK_IDS, fixtureRoot, fixtureSets, grade, resultsRoot } from "../src/index.js";
import { TOOL_CONTEXT, describeFindings, packageRoot, parseArgs, positiveInteger, prepareTrialDir, runClaude, runPool, usedModels } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const SET = args.set ?? "branching";
if (!fixtureSets().includes(SET)) throw new Error(`unknown fixture set ${SET}; have ${fixtureSets().join(", ")}`);
const MODEL = args.model ?? "claude-sonnet-5";
const ATTEMPTS = positiveInteger(args.attempts, "attempts", 3);
const CONCURRENCY = positiveInteger(args.concurrency, "concurrency", 5);
const TIMEOUT_MS = positiveInteger(args.timeoutMs, "timeoutMs", 10 * 60 * 1000);
const TASKS = args.tasks ? args.tasks.split(",") : TASK_IDS;
const PROMPTS = args.prompts ? args.prompts.split(",") : ["explicit", "finding"];
const OUT = args.out ?? `${SET}-v1.json`;
const WORK = resolve(args.work ?? join(process.env.TMPDIR ?? "/tmp", `mep-matrix-${SET}`));
const TOOLS = ["Read", "Edit", "Write", "Bash"];
for (const id of TASKS) if (!TASK_IDS.includes(id)) throw new Error(`unknown task ${id}`);

const load = (id, file) => JSON.parse(readFileSync(join(fixtureRoot, SET, id, file), "utf8"));
const promptFor = (task, form) => {
  if (form === "explicit") return task.prompt;
  const prompt = task.promptVariants?.[form];
  if (!prompt) throw new Error(`${SET}/${task.id} has no prompt variant ${form}`);
  return prompt;
};
const instructions = (prompt) => [
  "You are editing a synthetic HVAC plan.",
  "Read only `task.json` and `candidate.json` in the current directory, and edit only `candidate.json`.",
  "Do not read, list, or search any other file or directory.",
  "",
  `Task: ${prompt}`,
  "",
  ...TOOL_CONTEXT,
  "",
  "Write the full updated plan JSON back to `candidate.json`.",
].join("\n");

async function runTrial(id, form, attempt) {
  const task = load(id, "task.json"); const starter = load(id, "starter.json");
  const prompt = promptFor(task, form);
  // The explicit form sees the task metadata (target, guard) as in v0.1.0; every other form
  // sees only the finding-style prompt and must discover the affected items itself.
  const { promptVariants, ...explicitTask } = task;
  const visibleTask = form === "explicit" ? explicitTask : { id: task.id, prompt };
  const dir = join(WORK, `${id}-${form}-${attempt}`);
  prepareTrialDir(dir, { task: visibleTask, starter, tool: true });
  const run = await runClaude(dir, instructions(prompt), TOOLS, { model: MODEL, timeoutMs: TIMEOUT_MS });
  const candidateText = readFileSync(join(dir, "candidate.json"), "utf8");
  // A candidate that is not valid JSON or not a valid plan is a graded failure of the editor,
  // recorded as such (with the validator message), not a runner crash.
  let result = null; let invalidCandidate = null;
  try { result = grade(task, starter, JSON.parse(candidateText)); }
  catch (error) {
    if (!(error instanceof BenchmarkInputError || error instanceof SyntaxError)) throw error;
    invalidCandidate = `${error.name}: ${error.message}`;
  }
  const passed = result?.passed ?? false;
  console.error(`${id}/${form}#${attempt}: ${passed ? "PASS" : "FAIL"} ${(run.duration_ms / 1000).toFixed(1)}s${passed ? "" : result ? ` guard=${result.mutationGuard.passed} resolved=${result.target.resolved} ${describeFindings(result).join("; ")} ${result.mutationGuard.violations.join("; ")}` : ` invalid candidate: ${invalidCandidate}`}`);
  return {
    taskId: id, promptForm: form, attempt, passed, targetResolved: result?.target.resolved ?? false, mutationGuardPassed: result?.mutationGuard.passed ?? false,
    mutationGuardViolations: result?.mutationGuard.violations ?? [], finalFindings: result ? describeFindings(result) : [],
    ...(invalidCandidate === null ? {} : { invalidCandidate }),
    models: usedModels(run), durationSeconds: Math.round(run.duration_ms / 100) / 10, turns: run.num_turns, costUsd: run.total_cost_usd,
    candidate: `${SET}/candidates/${id}-${form}-${attempt}.json`, candidateText,
  };
}

const trials = await runPool(TASKS.flatMap((id) => PROMPTS.flatMap((form) => Array.from({ length: ATTEMPTS }, (_, i) => [id, form, i + 1]))), CONCURRENCY, runTrial);
trials.sort((a, b) => TASK_IDS.indexOf(a.taskId) - TASK_IDS.indexOf(b.taskId) || PROMPTS.indexOf(a.promptForm) - PROMPTS.indexOf(b.promptForm) || a.attempt - b.attempt);
mkdirSync(join(resultsRoot, SET, "candidates"), { recursive: true });
for (const trial of trials) { writeFileSync(join(resultsRoot, trial.candidate), trial.candidateText); delete trial.candidateText; }
const tally = (own) => ({ passes: own.filter((t) => t.passed).length, attempts: own.length, meanDurationSeconds: Math.round(own.reduce((s, t) => s + t.durationSeconds, 0) / own.length * 10) / 10 });
const summary = { passes: trials.filter((t) => t.passed).length, attempts: trials.length };
const recorded = {
  benchmarkVersion: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version,
  fixtureSet: SET, date: new Date().toISOString().slice(0, 10),
  agent: { surface: "claude -p (headless, fresh process per attempt, --no-session-persistence)", requestedModel: MODEL, tools: TOOLS, context: "candidate.json plus a trial-local task.json: the explicit form sees prompt, target, and approved mutation; other forms see only id and prompt. A shell wrapper for `mep-benchmark size` is available. No oracle, grader, domain source, repository fixture, or other task access." },
  summary: { ...summary, passRate: Math.round((summary.passes / summary.attempts) * 1000) / 1000 },
  byTask: Object.fromEntries(TASKS.map((id) => [id, tally(trials.filter((t) => t.taskId === id))])),
  byPromptForm: Object.fromEntries(PROMPTS.map((form) => [form, tally(trials.filter((t) => t.promptForm === form))])),
  byTaskAndPromptForm: Object.fromEntries(TASKS.map((id) => [id, Object.fromEntries(PROMPTS.map((form) => [form, tally(trials.filter((t) => t.taskId === id && t.promptForm === form))]))])),
  trials,
  limitations: [
    `${ATTEMPTS} attempts per task and prompt form on one synthetic fixture set.`,
    "Model identifiers come from the runner's reported usage; durations are the runner's reported wall clock for the editor process.",
    "This result is a capability observation, not a reliability, engineering, or code-compliance claim.",
  ],
};
writeFileSync(join(resultsRoot, OUT), `${JSON.stringify(recorded, null, 2)}\n`);
console.log(JSON.stringify({ summary: recorded.summary, byTask: recorded.byTask, byPromptForm: recorded.byPromptForm }, null, 2));
