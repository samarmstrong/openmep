import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkInputError, validatePlan, validateTask } from "./schema.js";
import { grade, report } from "./grader.js";
export const fixtureRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures");
export const resultsRoot = join(dirname(fixtureRoot), "results");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const TASK_IDS = ["T1", "T2", "T3", "T4", "T5", "T6"];
const FIXTURE_FILES = ["task.json", "starter.json", "oracle.json", "initial-report.json"];
export function fixtureSets(root = fixtureRoot) {
  const sets = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (sets.length === 0) throw new Error(`no fixture sets under ${root}`);
  return sets;
}
export function verifyFixtures(root = fixtureRoot) {
  const manifestText = readFileSync(join(root, "manifest.sha256"), "utf8"); const expected = new Map(manifestText.trim().split("\n").map((line) => { const [hash, file] = line.split("  "); return [file, hash]; }));
  const sets = fixtureSets(root);
  const files = sets.flatMap((set) => TASK_IDS.flatMap((id) => FIXTURE_FILES.map((file) => `${set}/${id}/${file}`)));
  if (files.length !== expected.size || files.some((file) => !expected.has(file))) throw new Error("fixture manifest file set does not match <set>/T1–T6 fixture layout");
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8"); if (sha256(text) !== expected.get(file)) throw new Error(`SHA-256 mismatch for ${file}`);
    const value = JSON.parse(text); if (file.endsWith("task.json")) validateTask(value); if (file.endsWith("starter.json") || file.endsWith("oracle.json")) validatePlan(value);
  }
  for (const set of sets) for (const id of TASK_IDS) {
    const dir = join(root, set, id);
    const starter = JSON.parse(readFileSync(join(dir, "starter.json"), "utf8"));
    const expectedReport = JSON.parse(readFileSync(join(dir, "initial-report.json"), "utf8"));
    const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
    const oracle = JSON.parse(readFileSync(join(dir, "oracle.json"), "utf8"));
    if (task.id !== id) throw new Error(`${set}/${id}/task.json declares id ${task.id}`);
    const actualReport = report(starter, task);
    if (JSON.stringify(actualReport) !== JSON.stringify(expectedReport)) throw new Error(`initial report does not match starter for ${set}/${id}`);
    if (actualReport.findings.length !== 1) throw new Error(`${set}/${id} must begin with exactly one intended finding`);
    if (!grade(task, starter, oracle).passed) throw new Error(`${set}/${id} oracle does not pass deterministic grading`);
  }
  if (root === fixtureRoot) verifyRecordedResults();
  return { passed: true, files };
}

export function verifyRecordedResults(root = resultsRoot) {
  const manifestText = readFileSync(join(root, "manifest.sha256"), "utf8");
  const expected = new Map(manifestText.trim().split("\n").map((line) => { const [hash, file] = line.split("  "); return [file, hash]; }));
  const files = listFiles(root).filter((file) => file !== "manifest.sha256");
  if (files.length !== expected.size || files.some((file) => !expected.has(file))) throw new Error("result manifest file set does not match the files under results/");
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    if (sha256(text) !== expected.get(file)) throw new Error(`SHA-256 mismatch for results/${file}`);
  }
  const recordedRuns = files.filter((file) => /^[^/]+\.json$/.test(file));
  if (recordedRuns.length === 0) throw new Error("results/ must contain at least one recorded run");
  for (const file of recordedRuns) verifyRecordedRun(root, JSON.parse(readFileSync(join(root, file), "utf8")), file);
  return { passed: true, files };
}

function verifyRecordedRun(root, recorded, file) {
  if (!Array.isArray(recorded.trials) || !recorded.summary) throw new Error(`results/${file} must record trials and a summary`);
  if (typeof recorded.fixtureSet !== "string" || !fixtureSets().includes(recorded.fixtureSet)) throw new Error(`results/${file} must name an existing fixtureSet`);
  const outcomes = recorded.trials.map((trial) => {
    const taskDir = join(fixtureRoot, recorded.fixtureSet, trial.taskId);
    // A recorded candidate that is not valid JSON or not a valid plan is a graded failure.
    let passed;
    try {
      passed = grade(
        JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")),
        JSON.parse(readFileSync(join(taskDir, "starter.json"), "utf8")),
        JSON.parse(readFileSync(join(root, trial.candidate), "utf8")),
      ).passed;
    } catch (error) {
      if (!(error instanceof BenchmarkInputError || error instanceof SyntaxError)) throw error;
      passed = false;
    }
    if (passed !== trial.passed) throw new Error(`recorded outcome does not match grading for ${trial.taskId} in results/${file} (${trial.candidate})`);
    return passed;
  });
  const passes = outcomes.filter(Boolean).length;
  if (passes !== recorded.summary.passes || outcomes.length !== recorded.summary.attempts) throw new Error(`recorded summary does not match trial outcomes in results/${file}`);
}

function listFiles(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(root, rel) : [rel];
  }).sort();
}
