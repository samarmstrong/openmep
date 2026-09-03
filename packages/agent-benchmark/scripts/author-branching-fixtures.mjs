#!/usr/bin/env node
// Deterministically authors the `branching` fixture set: one AHU feeding a main, two branches,
// and seven runouts across four rooms. Each task injects one fault into the same base network.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureRoot, report, sizeSegment } from "../src/index.js";

const size = (cfm, role) => sizeSegment({ cfm, airflowType: "supply", role }).standardDiameterIn;
const clone = (value) => JSON.parse(JSON.stringify(value));

export function basePlan() {
  return {
    version: 1,
    spaces: [
      { id: "ROOM-1", bounds: [0, 0, 12, 10], designCfm: 150 },
      { id: "ROOM-2", bounds: [12, 0, 24, 10], designCfm: 250 },
      { id: "ROOM-3", bounds: [0, 10, 12, 20], designCfm: 100 },
      { id: "ROOM-4", bounds: [12, 10, 24, 20], designCfm: 200 },
    ],
    equipment: [{ id: "AHU-1", kind: "ahu" }],
    terminals: [
      { id: "D-1A", spaceId: "ROOM-1", position: [3, 5], cfm: 75, connections: ["RO-1A"] },
      { id: "D-1B", spaceId: "ROOM-1", position: [9, 5], cfm: 75, connections: ["RO-1B"] },
      { id: "D-2A", spaceId: "ROOM-2", position: [15, 5], cfm: 125, connections: ["RO-2A"] },
      { id: "D-2B", spaceId: "ROOM-2", position: [21, 5], cfm: 125, connections: ["RO-2B"] },
      { id: "D-3A", spaceId: "ROOM-3", position: [6, 15], cfm: 100, connections: ["RO-3A"] },
      { id: "D-4A", spaceId: "ROOM-4", position: [15, 15], cfm: 100, connections: ["RO-4A"] },
      { id: "D-4B", spaceId: "ROOM-4", position: [21, 15], cfm: 100, connections: ["RO-4B"] },
    ],
    segments: [
      { id: "MAIN-1", diameterIn: size(700, "main"), connections: ["AHU-1", "BR-1", "BR-2"] },
      { id: "BR-1", diameterIn: size(250, "branch"), connections: ["MAIN-1", "RO-1A", "RO-1B", "RO-3A"] },
      { id: "BR-2", diameterIn: size(450, "branch"), connections: ["MAIN-1", "RO-2A", "RO-2B", "RO-4A", "RO-4B"] },
      { id: "RO-1A", diameterIn: size(75, "runout"), connections: ["BR-1", "D-1A"] },
      { id: "RO-1B", diameterIn: size(75, "runout"), connections: ["BR-1", "D-1B"] },
      { id: "RO-2A", diameterIn: size(125, "runout"), connections: ["BR-2", "D-2A"] },
      { id: "RO-2B", diameterIn: size(125, "runout"), connections: ["BR-2", "D-2B"] },
      { id: "RO-3A", diameterIn: size(100, "runout"), connections: ["BR-1", "D-3A"] },
      { id: "RO-4A", diameterIn: size(100, "runout"), connections: ["BR-2", "D-4A"] },
      { id: "RO-4B", diameterIn: size(100, "runout"), connections: ["BR-2", "D-4B"] },
    ],
  };
}

const item = (plan, collection, id) => plan[collection].find((entry) => entry.id === id);

export function authorBranching() {
  const oracle = basePlan();
  const branchIn = item(oracle, "segments", "BR-1").diameterIn;
  const tasks = {
    T1: {
      fault(plan) { plan.terminals = plan.terminals.filter((t) => t.id !== "D-4B"); item(plan, "segments", "RO-4B").connections = ["BR-2"]; },
      task: {
        id: "T1",
        prompt: "T1 — Restore ROOM-4 supply. Add supply terminal D-4B inside ROOM-4 with 100 CFM and connect it to runout RO-4B so the room receives its 200 CFM design airflow. Preserve every existing item.",
        promptVariants: { finding: "Validation finding: space-cfm — ROOM-4 receives 100 CFM but its design airflow is 200 CFM. Resolve it by adding exactly one supply terminal, named D-4B, inside that room and connecting it to the existing runout stub that currently serves no terminal. Preserve every existing item." },
        target: { spaceId: "ROOM-4", designCfm: 200 },
        approvedMutation: { paths: ["segment.RO-4B.connections"], additions: { terminals: ["D-4B"] } },
      },
    },
    T2: {
      fault(plan) { item(plan, "terminals", "D-3A").position = [15, 12]; },
      task: {
        id: "T2",
        prompt: "T2 — Move diffuser D-3A into its declared room ROOM-3. Change only its position.",
        promptVariants: { finding: "Validation finding: terminal-in-room — one supply terminal lies outside the room it is assigned to. Fix it by changing only that terminal's position." },
        target: { terminalId: "D-3A", spaceId: "ROOM-3" },
        approvedMutation: { paths: ["terminal.D-3A.position"] },
      },
    },
    T3: {
      fault(plan) { item(plan, "terminals", "D-2B").connections = []; },
      task: {
        id: "T3",
        prompt: "T3 — Reconnect orphan diffuser D-2B to runout RO-2B. Change only its connections.",
        promptVariants: { finding: "Validation finding: connectivity — one supply terminal has no duct path to supply equipment. Fix it by changing only that terminal's connections." },
        target: { terminalId: "D-2B" },
        approvedMutation: { paths: ["terminal.D-2B.connections"] },
      },
    },
    T4: {
      fault(plan) { item(plan, "segments", "BR-1").diameterIn = 6; },
      task: {
        id: "T4",
        prompt: "T4 — Size branch BR-1 for the 250 CFM it carries using the benchmark's equal-friction sizing engine. Change only diameterIn.",
        promptVariants: { finding: "Validation finding: duct-sizing — one supply branch is undersized for the airflow it carries to its downstream terminals. Fix it by changing only that segment's diameterIn, sized with the benchmark's equal-friction sizing engine." },
        target: { segmentId: "BR-1", cfm: 250, role: "branch" },
        approvedMutation: { paths: ["segment.BR-1.diameterIn"] },
      },
    },
    T5: {
      fault(plan) { item(plan, "terminals", "D-2A").cfm = 200; item(plan, "terminals", "D-2B").cfm = 50; },
      task: {
        id: "T5",
        prompt: "T5 — Balance ROOM-2. Set both of its supply terminals to equal flow while preserving their 250 CFM total. Change only their cfm values.",
        promptVariants: { finding: "Validation finding: terminal-balance — one room's two supply terminals carry unequal airflow. Fix it by changing only their cfm values so they are equal and still total that room's design airflow." },
        target: { spaceId: "ROOM-2", terminalIds: ["D-2A", "D-2B"], eachCfm: 125, designCfm: 250 },
        approvedMutation: { paths: ["terminal.D-2A.cfm", "terminal.D-2B.cfm"] },
      },
    },
    T6: {
      fault(plan) {
        plan.terminals = plan.terminals.filter((t) => t.id !== "D-4B");
        plan.segments = plan.segments.filter((s) => s.id !== "RO-4B");
        item(plan, "segments", "BR-2").connections = item(plan, "segments", "BR-2").connections.filter((id) => id !== "RO-4B");
      },
      task: {
        id: "T6",
        prompt: "T6 — Restore ROOM-4's second supply run. Add supply terminal D-4B inside ROOM-4 with 100 CFM, add runout RO-4B connecting it to branch BR-2, and set the new runout's diameterIn with the benchmark's equal-friction sizing engine. Preserve every existing item.",
        promptVariants: { finding: "Validation finding: space-cfm — ROOM-4 receives 100 CFM but its design airflow is 200 CFM, and no unused runout stub exists. Resolve it by adding exactly one supply terminal named D-4B inside that room and exactly one new runout named RO-4B connecting it to the branch that already serves the room, with the runout's diameterIn set by the benchmark's equal-friction sizing engine. Preserve every existing item." },
        target: { spaceId: "ROOM-4", designCfm: 200, terminalId: "D-4B", terminalCfm: 100, segmentId: "RO-4B", cfm: 100, role: "runout" },
        approvedMutation: { paths: ["segment.BR-2.connections"], additions: { terminals: ["D-4B"], segments: ["RO-4B"] } },
      },
    },
  };
  if (branchIn === 6) throw new Error("T4 fault must differ from the engine's branch size");
  return Object.fromEntries(Object.entries(tasks).map(([id, { fault, task }]) => {
    const starter = clone(oracle); fault(starter);
    return [id, {
      "task.json": `${JSON.stringify(task, null, 2)}\n`,
      "starter.json": JSON.stringify(starter),
      "oracle.json": JSON.stringify(oracle),
      "initial-report.json": JSON.stringify(report(starter, task)),
    }];
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fixtureRoot, "branching");
  for (const [id, files] of Object.entries(authorBranching())) {
    mkdirSync(join(root, id), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, id, name), text);
    console.log(`${id}: ${JSON.parse(files["initial-report.json"]).findings.map((f) => f.check).join(", ")}`);
  }
  console.log(`base network: ${JSON.stringify(basePlan().segments.map((s) => `${s.id}=${s.diameterIn}in`))}`);
}
