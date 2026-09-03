import { BenchmarkInputError, validatePlan, validateTask } from "./schema.js";
import { sizeSegment } from "./sizing.js";

const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inBounds = (position, bounds) => position[0] >= bounds[0] && position[0] <= bounds[2] && position[1] >= bounds[1] && position[1] <= bounds[3];
const byId = (items) => new Map(items.map((item) => [item.id, item]));
const expectedTargetDiameter = (task) => sizeSegment({
  cfm: task.target.cfm,
  airflowType: "supply",
  role: task.target.role,
}).standardDiameterIn;

export function report(planValue, taskValue = null) {
  const plan = validatePlan(planValue); const findings = []; const spaces = byId(plan.spaces);
  for (const terminal of plan.terminals) {
    if (!inBounds(terminal.position, spaces.get(terminal.spaceId).bounds)) findings.push({ severity: "error", check: "terminal-in-room", itemId: terminal.id });
  }
  for (const space of plan.spaces) {
    const supplied = plan.terminals.filter((t) => t.spaceId === space.id).reduce((sum, t) => sum + t.cfm, 0);
    if (Math.abs(supplied - space.designCfm) > 0.001) findings.push({ severity: "error", check: "space-cfm", spaceId: space.id, expected: space.designCfm, actual: supplied });
  }
  const segments = byId(plan.segments); const ahus = new Set(plan.equipment.map((e) => e.id));
  const reachesAhu = (terminal) => {
    const queue = [...terminal.connections]; const seen = new Set();
    while (queue.length) { const id = queue.shift(); if (seen.has(id)) continue; seen.add(id); const segment = segments.get(id); if (!segment) continue; for (const next of segment.connections) { if (ahus.has(next)) return true; if (segments.has(next)) queue.push(next); } }
    return false;
  };
  for (const terminal of plan.terminals) if (!reachesAhu(terminal)) findings.push({ severity: "warning", check: "connectivity", itemId: terminal.id });
  if (taskValue) {
    const task = validateTask(taskValue);
    if (task.id === "T4") {
      const segment = segments.get(task.target.segmentId);
      const expected = expectedTargetDiameter(task);
      if (!segment || segment.diameterIn !== expected) findings.push({ severity: "error", check: "duct-sizing", itemId: task.target.segmentId, expected, actual: segment?.diameterIn ?? null });
    }
    if (task.id === "T6") {
      // The target segment does not exist in the starter, so sizing is only checked once it appears;
      // its absence is caught by targetResolved, not by a baseline finding.
      const segment = segments.get(task.target.segmentId);
      const expected = expectedTargetDiameter(task);
      if (segment && segment.diameterIn !== expected) findings.push({ severity: "error", check: "duct-sizing", itemId: task.target.segmentId, expected, actual: segment.diameterIn });
    }
    if (task.id === "T5") {
      const terminalsById = byId(plan.terminals);
      const values = task.target.terminalIds.map((id) => terminalsById.get(id)?.cfm ?? null);
      if (!values.every((value) => value === task.target.eachCfm)) findings.push({ severity: "error", check: "terminal-balance", spaceId: task.target.spaceId, expectedEach: task.target.eachCfm, actual: values });
    }
  }
  return { errors: findings.filter((f) => f.severity === "error"), warnings: findings.filter((f) => f.severity === "warning"), findings };
}
function targetResolved(task, candidate) {
  const target = task.target; const terminals = byId(candidate.terminals); const segments = byId(candidate.segments); const spaces = byId(candidate.spaces);
  if (task.id === "T1") return candidate.terminals.filter((t) => t.spaceId === target.spaceId).reduce((s, t) => s + t.cfm, 0) === target.designCfm;
  if (task.id === "T2") return inBounds(terminals.get(target.terminalId).position, spaces.get(target.spaceId).bounds);
  if (task.id === "T3") return !report(candidate, task).warnings.some((f) => f.check === "connectivity" && f.itemId === target.terminalId);
  if (task.id === "T4") return segments.get(target.segmentId).diameterIn === expectedTargetDiameter(task);
  if (task.id === "T6") {
    const terminal = terminals.get(target.terminalId); const segment = segments.get(target.segmentId);
    if (!terminal || !segment) return false;
    const supplied = candidate.terminals.filter((t) => t.spaceId === target.spaceId).reduce((s, t) => s + t.cfm, 0);
    return terminal.cfm === target.terminalCfm && supplied === target.designCfm
      && segment.diameterIn === expectedTargetDiameter(task)
      && !report(candidate, task).warnings.some((f) => f.check === "connectivity" && f.itemId === target.terminalId);
  }
  const values = target.terminalIds.map((id) => terminals.get(id).cfm); return values.every((value) => value === target.eachCfm) && values.reduce((a, b) => a + b, 0) === target.designCfm;
}
function mutationGuard(task, starter, candidate) {
  const permitted = new Set(task.approvedMutation.paths); const base = clone(starter); const edit = clone(candidate);
  for (const path of permitted) {
    const [kind, id, field] = path.split("."); const a = base[`${kind}s`]?.find((x) => x.id === id); const b = edit[`${kind}s`]?.find((x) => x.id === id);
    if (!a || !b || !field) return { passed: false, violations: [`invalid approved path ${path}`] };
    delete a[field]; delete b[field];
  }
  for (const [collection, itemIds] of Object.entries(task.approvedMutation.additions ?? {})) {
    for (const id of itemIds) {
      if (base[collection].some((item) => item.id === id)) return { passed: false, violations: [`approved addition ${collection}.${id} already exists in starter`] };
      const index = edit[collection].findIndex((item) => item.id === id);
      if (index < 0) return { passed: false, violations: [`candidate is missing approved addition ${collection}.${id}`] };
      edit[collection].splice(index, 1);
    }
  }
  return same(base, edit) ? { passed: true, violations: [] } : { passed: false, violations: ["candidate changed data outside the approved mutation plan"] };
}
const findingKey = (f) => `${f.check}|${f.itemId ?? ""}|${f.spaceId ?? ""}`;
export function grade(taskValue, starterValue, candidateValue) {
  const task = validateTask(taskValue); const starter = validatePlan(starterValue); const candidate = validatePlan(candidateValue);
  const baseline = report(starter, task); const current = report(candidate, task); const guard = mutationGuard(task, starter, candidate);
  const baselineTarget = targetResolved(task, starter); const resolved = targetResolved(task, candidate);
  const baselineErrors = new Set(baseline.errors.map(findingKey)); const newErrors = current.errors.filter((f) => !baselineErrors.has(findingKey(f)));
  const passed = !baselineTarget && resolved && newErrors.length === 0 && guard.passed;
  return { taskId: task.id, passed, target: { baselineFailed: !baselineTarget, resolved }, mutationGuard: guard, baseline, current, newErrors };
}
export { BenchmarkInputError };
