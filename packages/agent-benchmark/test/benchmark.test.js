import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { BenchmarkInputError, TASK_IDS, fixtureRoot, fixtureSets, grade, validatePlan, verifyFixtures } from "../src/index.js";
import { authorBranching } from "../scripts/author-branching-fixtures.mjs";
const SETS = ["branching", "single"];
const FILES = ["task.json", "starter.json", "oracle.json", "initial-report.json"];
const load = (set, id, file) => JSON.parse(readFileSync(join(fixtureRoot, set, id, file), "utf8"));
const cases = SETS.flatMap((set) => TASK_IDS.map((id) => [set, id]));

test("all fixture hashes and schemas are stable", () => {
  assert.deepEqual(fixtureSets(), SETS);
  assert.deepEqual(verifyFixtures(), { passed: true, files: SETS.flatMap((set) => TASK_IDS.flatMap((id) => FILES.map((file) => `${set}/${id}/${file}`))) });
});
test("branching fixtures are reproduced byte-for-byte by their authoring script", () => {
  for (const [id, files] of Object.entries(authorBranching())) for (const [name, text] of Object.entries(files)) assert.equal(readFileSync(join(fixtureRoot, "branching", id, name), "utf8"), text, `branching/${id}/${name}`);
});
test("prompt variants are validated and explicit is reserved", () => {
  const task = load("branching", "T2", "task.json");
  assert.equal(typeof task.promptVariants.finding, "string");
  assert.throws(() => grade({ ...task, promptVariants: { explicit: "x" } }, load("branching", "T2", "starter.json"), load("branching", "T2", "oracle.json")), /reserved/);
  assert.throws(() => grade({ ...task, promptVariants: { finding: 3 } }, load("branching", "T2", "starter.json"), load("branching", "T2", "oracle.json")), BenchmarkInputError);
});
test("malformed plans fail loudly", () => {
  assert.throws(() => validatePlan({ version: 1 }), BenchmarkInputError);
  assert.throws(() => validatePlan({ version: 2, spaces: [], equipment: [], terminals: [], segments: [] }), /version/);
});
for (const [set, id] of cases) test(`${set}/${id} baseline fails and oracle passes`, () => {
  const task = load(set, id, "task.json"); const starter = load(set, id, "starter.json"); const oracle = load(set, id, "oracle.json");
  assert.equal(grade(task, starter, starter).passed, false);
  assert.equal(grade(task, starter, oracle).passed, true);
});
for (const [set, id] of cases) test(`${set}/${id} mutation guard rejects an unrelated edit`, () => {
  const task = load(set, id, "task.json"); const starter = load(set, id, "starter.json"); const candidate = load(set, id, "oracle.json");
  candidate.spaces[0].bounds[2] += 1;
  const result = grade(task, starter, candidate);
  assert.equal(result.target.resolved, true); assert.equal(result.mutationGuard.passed, false); assert.equal(result.passed, false);
});
test("T1 permits only the declared terminal addition", () => {
  const task = load("single", "T1", "task.json"); const starter = load("single", "T1", "starter.json"); const candidate = load("single", "T1", "oracle.json");
  candidate.terminals.push({ id: "UNAPPROVED", spaceId: "ROOM-A", position: [2, 2], cfm: 0, connections: ["T1-S1"] });
  assert.equal(grade(task, starter, candidate).mutationGuard.passed, false);
});
test("T4 ground truth comes from the public sizing engine", () => {
  const task = load("single", "T4", "task.json"); const starter = load("single", "T4", "starter.json"); const oracle = load("single", "T4", "oracle.json");
  assert.equal(oracle.segments.find((segment) => segment.id === task.target.segmentId).diameterIn, 7);
  assert.equal(grade(task, starter, oracle).passed, true);
});
for (const set of SETS) test(`${set}/T6 rejects a mis-sized added runout`, () => {
  const task = load(set, "T6", "task.json"); const starter = load(set, "T6", "starter.json"); const candidate = load(set, "T6", "oracle.json");
  candidate.segments.find((segment) => segment.id === task.target.segmentId).diameterIn += 1;
  const result = grade(task, starter, candidate);
  assert.equal(result.target.resolved, false);
  assert.ok(result.newErrors.some((f) => f.check === "duct-sizing" && f.itemId === task.target.segmentId));
  assert.equal(result.passed, false);
});
for (const set of SETS) test(`${set}/T6 rejects an added terminal with no duct path to the AHU`, () => {
  const task = load(set, "T6", "task.json"); const starter = load(set, "T6", "starter.json"); const candidate = load(set, "T6", "oracle.json");
  const runout = candidate.segments.find((segment) => segment.id === task.target.segmentId);
  runout.connections = runout.connections.filter((id) => id === task.target.terminalId);
  const result = grade(task, starter, candidate);
  assert.equal(result.target.resolved, false);
  assert.equal(result.passed, false);
});
test("CLI reserves 0, 1, and 2 for pass, graded failure, and malformed input", () => {
  const cli = join(fixtureRoot, "..", "bin", "mep-benchmark.js");
  assert.equal(spawnSync(process.execPath, [cli, "grade", join(fixtureRoot, "single", "T1"), join(fixtureRoot, "single", "T1", "oracle.json")]).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, "grade", join(fixtureRoot, "single", "T1")]).status, 1);
  assert.equal(spawnSync(process.execPath, [cli, "grade"]).status, 2);
});
test("CLI size exposes the grader's sizing oracle and rejects unknown roles", () => {
  const cli = join(fixtureRoot, "..", "bin", "mep-benchmark.js");
  const sized = spawnSync(process.execPath, [cli, "size", "100", "supply", "runout"], { encoding: "utf8" });
  assert.equal(sized.status, 0);
  assert.equal(JSON.parse(sized.stdout).standardDiameterIn, 7);
  assert.equal(spawnSync(process.execPath, [cli, "size", "100", "supply", "duct"]).status, 2);
  assert.equal(spawnSync(process.execPath, [cli, "size", "abc", "supply", "runout"]).status, 2);
});
