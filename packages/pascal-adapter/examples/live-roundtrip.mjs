#!/usr/bin/env node
// Live round trip against a running Pascal editor (`npx @pascal-app/cli start`).
// Creates a project, builds the bundled furnace/tee/two-register scene through
// apply_patch, sizes it through Pascal's MCP with @openmep/pascal-adapter,
// checks the diameters, undoes the batch (one step), and redoes it.
// Requires a built dist/. Exit code 0 means every check passed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectPascalMcp, discoverPascalMcp, sizeThroughPascalMcp } from "../dist/index.js";

const discovered = discoverPascalMcp();
if (!discovered.ok) {
  console.error(discovered.message);
  process.exit(2);
}
console.log(`Pascal ${discovered.editorVersion ?? "?"} MCP at ${discovered.target.url}`);
const session = await connectPascalMcp(discovered.target);
console.log(`server: ${session.serverName} ${session.serverVersion}`);

const example = JSON.parse(readFileSync(fileURLToPath(new URL("./furnace-two-registers.json", import.meta.url)), "utf8"));
const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(label);
};
const diameters = async () => {
  const scene = await session.exportScene();
  return Object.fromEntries([...scene.hvacNodes.values()].filter((node) => node.type === "duct-segment").map((node) => [node.id, node.diameter]));
};

try {
  const project = await session.callTool("create_project", { name: `openmep-roundtrip ${new Date().toISOString().slice(0, 19)}` });
  console.log(`project ${project.id} -> ${project.editorUrl}`);

  // Parent the HVAC nodes to the project's default level. Nodes that are not
  // reachable from the scene's root are dropped when the browser opens the
  // project (and the loss is autosaved), so never create a detached level.
  const status = await session.callTool("get_project_status", { id: project.id });
  const levelId = status.defaultLevelId;
  check("project has a default level", typeof levelId === "string", status.levelIds);
  const created = await session.applyPatch(
    example.nodes.level_main.children.map((id) => ({ op: "create", node: { ...example.nodes[id], parentId: levelId }, parentId: levelId })),
  );
  check("apply_patch created 9 HVAC nodes under the default level", created.appliedOps === 9 && created.createdIds.length === 9, created);
  const before = await diameters();
  check("initial diameters", before["duct-segment_main"] === 6 && before["duct-segment_run_a"] === 6 && before["duct-segment_run_b"] === 6, before);

  const outcome = await sizeThroughPascalMcp(session);
  console.log(`findings: ${outcome.result.findings.map((finding) => `${finding.severity}:${finding.code}:${finding.nodeId ?? ""}`).join(", ")}`);
  check("three segments patched in one batch", outcome.applied?.appliedOps === 3, outcome.applied);
  check("no unsized supply segment", !outcome.result.findings.some((finding) => finding.code === "unsized-supply-segment"));
  check("verification after re-export", outcome.verification?.ok === true, outcome.verification);
  check("persisted to the bound project", outcome.applied?.persistence === null, outcome.applied?.persistence);
  const after = await diameters();
  check("sized diameters 9/8/7 in", after["duct-segment_main"] === 9 && after["duct-segment_run_a"] === 8 && after["duct-segment_run_b"] === 7 && after["duct-segment_return"] === 8, after);

  check("undo is one step", (await session.undo()) === 1);
  const undone = await diameters();
  check("undo restored 6/6/6 in", undone["duct-segment_main"] === 6 && undone["duct-segment_run_a"] === 6 && undone["duct-segment_run_b"] === 6, undone);
  check("redo is one step", (await session.redo()) === 1);
  const redone = await diameters();
  check("redo reapplied 9/8/7 in", redone["duct-segment_main"] === 9 && redone["duct-segment_run_a"] === 8 && redone["duct-segment_run_b"] === 7, redone);

  const second = await sizeThroughPascalMcp(session);
  check("second pass has nothing to patch", second.result.patches.length === 0 && second.applied === null, second.result.summary);
} finally {
  await session.close();
}
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("live round trip passed");
