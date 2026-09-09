// Re-grade frozen evidence. No agent process, network call, or file writes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, resultsRoot, grade, sizeSegment, verifyFixtures } from "../src/index.js";

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
verifyFixtures(); // Includes every recorded candidate and both SHA-256 manifests.
const record = json(join(resultsRoot, "t4-context-v1.json"));
const taskRoot = join(fixtureRoot, record.fixtureSet, record.task);
const task = json(join(taskRoot, "task.json"));
const starter = json(join(taskRoot, "starter.json"));
const size = sizeSegment({ cfm: task.target.cfm, airflowType: "supply", role: task.target.role });
assert.equal(size.standardDiameterIn, record.oracleDiameterIn, "Sizing engine changed from the recorded oracle");

const trials = record.trials.map((trial) => {
  const candidate = json(join(resultsRoot, trial.candidate));
  const result = grade(task, starter, candidate);
  const diameter = candidate.segments.find((segment) => segment.id === task.target.segmentId).diameterIn;
  assert.equal(diameter, trial.chosenDiameterIn, `Recorded diameter differs: ${trial.candidate}`);
  assert.equal(result.passed, trial.passed, `Recorded grade differs: ${trial.candidate}`);
  assert.equal(result.mutationGuard.passed, trial.mutationGuardPassed, `Mutation guard differs: ${trial.candidate}`);
  return { ...trial, diameter, result };
});

console.log("OpenMEP / T4 recorded-candidate replay");
console.log(`Evidence: ${record.date}, benchmark ${record.benchmarkVersion}; replay runtime: ${process.version}`);
console.log(`Requested model: ${record.agent.requestedModel}`);
console.log(`Reported usage IDs: ${[...new Set(trials.flatMap((trial) => trial.models))].join(", ")}`);
console.log(`Results manifest SHA-256: ${createHash("sha256").update(readFileSync(join(resultsRoot, "manifest.sha256"))).digest("hex")}`);
console.log("Fixture/result manifests and all recorded outcomes: verified\n");
console.log(`${task.target.segmentId}: ${task.target.cfm} CFM, supply ${task.target.role}`);
console.log(`Engine minimum: ${size.exactDiameterIn.toFixed(6)} in; selected standard: ${size.standardDiameterIn} in (${size.governingConstraint} governs)`);
console.log("\nCondition             Passes  Diameters (in)  Mean recorded duration");
for (const [variant, expected] of Object.entries(record.variants)) {
  const own = trials.filter((trial) => trial.variant === variant);
  const passes = own.filter((trial) => trial.result.passed).length;
  const diameters = own.map((trial) => trial.diameter);
  const mean = Math.round(own.reduce((sum, trial) => sum + trial.durationSeconds, 0) / own.length * 10) / 10;
  assert.equal(own.length, expected.attempts, `${variant}: attempt count differs`);
  assert.equal(passes, expected.passes, `${variant}: pass count differs`);
  assert.deepEqual(diameters, expected.chosenDiametersIn, `${variant}: diameters differ`);
  assert.equal(mean, expected.meanDurationSeconds, `${variant}: recorded duration summary differs`);
  console.log(`${variant.padEnd(22)}${`${passes}/${own.length}`.padEnd(8)}${diameters.join(", ").padEnd(16)}${mean.toFixed(1)} s`);
}

console.log("\nTwo independent attempts from the same 4-inch starter (not a sequential retry):");
for (const candidate of ["t4-context/candidates/V1-parameters-1.json", "t4-context/candidates/V4-tool-1.json"]) {
  const trial = trials.find((entry) => entry.candidate === candidate);
  assert.ok(trial, `Example missing from recorded evidence: ${candidate}`);
  const before = starter.segments.find((segment) => segment.id === task.target.segmentId).diameterIn;
  console.log(`\n${trial.candidate}`);
  console.log(`  diameterIn: ${before} -> ${trial.diameter}; ${trial.result.passed ? "PASS" : "FAIL"}; mutation guard: ${trial.result.mutationGuard.passed ? "PASS" : "FAIL"}`);
  for (const finding of trial.result.current.findings) {
    console.log(`  ${finding.check}: ${finding.itemId ?? finding.spaceId}, expected ${finding.expected}, actual ${finding.actual}`);
  }
  if (!trial.result.current.findings.length) console.log("  No remaining findings.");
}
console.log("\nReplay complete: frozen candidates re-graded; no new model trials or tool-call traces.");
console.log("One synthetic case, three attempts/condition. Shared sizing engine; not independent engineering validation.");
