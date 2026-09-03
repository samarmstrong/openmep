#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BenchmarkInputError, grade, sizeSegment, verifyFixtures } from "../src/index.js";
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const USAGE = "usage: mep-benchmark verify [fixtures-dir] | grade <task-dir> [candidate.json] | size <cfm> <supply|return|exhaust|outside-air> <main|branch|runout>";
function main(args) {
  const [command, first, second, third] = args;
  if (command === "verify" && !first) return verifyFixtures();
  if (command === "verify" && first) return verifyFixtures(resolve(first));
  if (command === "grade" && first) { const dir = resolve(first); return grade(json(join(dir, "task.json")), json(join(dir, "starter.json")), json(second ? resolve(second) : join(dir, "starter.json"))); }
  if (command === "size" && first && second && third) return { passed: true, ...sizeSegment({ cfm: Number(first), airflowType: second, role: third }) };
  throw new BenchmarkInputError(USAGE);
}
try { const result = main(process.argv.slice(2)); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1; } catch (error) { console.error(`${error.name}: ${error.message}`); process.exitCode = 2; }
