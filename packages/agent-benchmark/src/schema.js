/** Formal structural schema for the public benchmark boundary. */
export class BenchmarkInputError extends Error {
  constructor(message) { super(message); this.name = "BenchmarkInputError"; }
}
const fail = (message) => { throw new BenchmarkInputError(message); };
const object = (value, path) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  return value;
};
const array = (value, path) => { if (!Array.isArray(value)) fail(`${path} must be an array`); return value; };
const string = (value, path) => { if (typeof value !== "string" || !value) fail(`${path} must be a non-empty string`); return value; };
const number = (value, path) => { if (!Number.isFinite(value)) fail(`${path} must be a finite number`); return value; };
const ids = (items, path) => {
  const seen = new Set();
  for (const [i, item] of items.entries()) { string(item.id, `${path}[${i}].id`); if (seen.has(item.id)) fail(`${path} has duplicate id ${item.id}`); seen.add(item.id); }
  return seen;
};
export function validatePlan(value) {
  const plan = object(value, "plan");
  if (plan.version !== 1) fail("plan.version must be 1");
  const spaces = array(plan.spaces, "plan.spaces"); const equipment = array(plan.equipment, "plan.equipment");
  const terminals = array(plan.terminals, "plan.terminals"); const segments = array(plan.segments, "plan.segments");
  const spaceIds = ids(spaces, "plan.spaces"); ids(equipment, "plan.equipment"); const terminalIds = ids(terminals, "plan.terminals"); const segmentIds = ids(segments, "plan.segments");
  for (const [i, space] of spaces.entries()) {
    object(space, `plan.spaces[${i}]`); const b = array(space.bounds, `plan.spaces[${i}].bounds`);
    if (b.length !== 4 || !b.every(Number.isFinite) || b[0] >= b[2] || b[1] >= b[3]) fail(`plan.spaces[${i}].bounds must be [minX,minY,maxX,maxY]`);
    number(space.designCfm, `plan.spaces[${i}].designCfm`); if (space.designCfm < 0) fail(`plan.spaces[${i}].designCfm must be >= 0`);
  }
  for (const [i, item] of equipment.entries()) { object(item, `plan.equipment[${i}]`); if (item.kind !== "ahu") fail(`plan.equipment[${i}].kind must be ahu`); }
  for (const [i, terminal] of terminals.entries()) {
    object(terminal, `plan.terminals[${i}]`); if (!spaceIds.has(string(terminal.spaceId, `plan.terminals[${i}].spaceId`))) fail(`plan.terminals[${i}].spaceId is unknown`);
    const p = array(terminal.position, `plan.terminals[${i}].position`); if (p.length !== 2 || !p.every(Number.isFinite)) fail(`plan.terminals[${i}].position must be [x,y]`);
    number(terminal.cfm, `plan.terminals[${i}].cfm`); if (terminal.cfm < 0) fail(`plan.terminals[${i}].cfm must be >= 0`);
    array(terminal.connections, `plan.terminals[${i}].connections`).forEach((id, j) => { if (!segmentIds.has(string(id, `plan.terminals[${i}].connections[${j}]`))) fail(`plan.terminals[${i}].connections contains unknown segment`); });
  }
  for (const [i, segment] of segments.entries()) {
    object(segment, `plan.segments[${i}]`); number(segment.diameterIn, `plan.segments[${i}].diameterIn`); if (segment.diameterIn <= 0) fail(`plan.segments[${i}].diameterIn must be > 0`);
    array(segment.connections, `plan.segments[${i}].connections`).forEach((id, j) => { string(id, `plan.segments[${i}].connections[${j}]`); if (!terminalIds.has(id) && !equipment.some((e) => e.id === id) && !segmentIds.has(id)) fail(`plan.segments[${i}].connections contains unknown item`); });
  }
  return plan;
}
export function validateTask(value) {
  const task = object(value, "task");
  if (!["T1", "T2", "T3", "T4", "T5", "T6"].includes(task.id)) fail("task.id must be T1–T6");
  string(task.prompt, "task.prompt"); object(task.target, "task.target"); object(task.approvedMutation, "task.approvedMutation");
  if (task.promptVariants !== undefined) {
    object(task.promptVariants, "task.promptVariants");
    for (const [name, prompt] of Object.entries(task.promptVariants)) { if (name === "explicit") fail("task.promptVariants.explicit is reserved for task.prompt"); string(prompt, `task.promptVariants.${name}`); }
  }
  if (!Array.isArray(task.approvedMutation.paths)) fail("task.approvedMutation.paths must be an array");
  task.approvedMutation.paths.forEach((path, i) => string(path, `task.approvedMutation.paths[${i}]`));
  const additions = task.approvedMutation.additions ?? {};
  object(additions, "task.approvedMutation.additions");
  for (const [collection, itemIds] of Object.entries(additions)) {
    if (!["spaces", "equipment", "terminals", "segments"].includes(collection)) fail(`unsupported approved addition collection ${collection}`);
    array(itemIds, `task.approvedMutation.additions.${collection}`).forEach((id, i) => string(id, `task.approvedMutation.additions.${collection}[${i}]`));
  }
  if (task.approvedMutation.paths.length === 0 && Object.keys(additions).length === 0) fail("task.approvedMutation must permit at least one path or addition");
  switch (task.id) {
    case "T1": string(task.target.spaceId, "task.target.spaceId"); number(task.target.designCfm, "task.target.designCfm"); break;
    case "T2": string(task.target.terminalId, "task.target.terminalId"); string(task.target.spaceId, "task.target.spaceId"); break;
    case "T3": string(task.target.terminalId, "task.target.terminalId"); break;
    case "T4":
      string(task.target.segmentId, "task.target.segmentId");
      number(task.target.cfm, "task.target.cfm");
      if (task.target.cfm <= 0) fail("task.target.cfm must be positive");
      if (!["main", "branch", "runout"].includes(task.target.role)) fail("task.target.role must be main, branch, or runout");
      break;
    case "T5": {
      string(task.target.spaceId, "task.target.spaceId");
      const terminalIds = array(task.target.terminalIds, "task.target.terminalIds");
      if (terminalIds.length < 2) fail("task.target.terminalIds must contain at least two terminals");
      terminalIds.forEach((id, i) => string(id, `task.target.terminalIds[${i}]`));
      number(task.target.eachCfm, "task.target.eachCfm"); number(task.target.designCfm, "task.target.designCfm"); break;
    }
    case "T6":
      string(task.target.spaceId, "task.target.spaceId"); number(task.target.designCfm, "task.target.designCfm");
      string(task.target.terminalId, "task.target.terminalId");
      number(task.target.terminalCfm, "task.target.terminalCfm"); if (task.target.terminalCfm <= 0) fail("task.target.terminalCfm must be positive");
      string(task.target.segmentId, "task.target.segmentId");
      number(task.target.cfm, "task.target.cfm"); if (task.target.cfm <= 0) fail("task.target.cfm must be positive");
      if (!["main", "branch", "runout"].includes(task.target.role)) fail("task.target.role must be main, branch, or runout");
      break;
  }
  return task;
}
