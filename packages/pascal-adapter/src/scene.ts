import { PascalAdapterError } from "./errors.js";

export type Vec3 = readonly [number, number, number];
export type DuctShape = "round" | "rect" | "oval";
export type PascalSystem = "supply" | "return";
export type TerminalType = "supply-register" | "diffuser" | "return-grille";
export type TerminalMount = "floor" | "ceiling" | "wall";
export type EquipmentType = "furnace" | "air-handler" | "condenser";

type NodeBase = {
  id: string;
  parentId: string | null;
  metadata: Readonly<Record<string, unknown>>;
};

/** `duct-segment`: polyline run in level-local metres; sizes in inches. */
export type PascalDuctSegment = NodeBase & {
  type: "duct-segment";
  path: readonly Vec3[];
  shape: DuctShape;
  diameter: number;
  width: number;
  height: number;
  system: PascalSystem;
};

/** `duct-fitting`: elbow, tee, cross, reducer, ... with an XYZ Euler rotation. */
export type PascalDuctFitting = NodeBase & {
  type: "duct-fitting";
  position: Vec3;
  rotation: Vec3;
  fittingType: string;
  shape: DuctShape;
  shape2: DuctShape;
  diameter: number;
  diameter2: number;
  width: number;
  height: number;
  width2: number;
  height2: number;
  angle: number;
  branchAngle: number;
  system: PascalSystem;
};

/** `duct-terminal`: register, diffuser, or return grille with one collar port. */
export type PascalDuctTerminal = NodeBase & {
  type: "duct-terminal";
  position: Vec3;
  rotation: number;
  terminalType: TerminalType;
  mount: TerminalMount;
  collarShape: DuctShape;
  collarDiameter: number;
  collarWidth: number;
  collarHeight: number;
};

/** `hvac-equipment`: furnace / air handler (duct ports) or condenser (none). */
export type PascalHvacEquipment = NodeBase & {
  type: "hvac-equipment";
  position: Vec3;
  rotation: number;
  equipmentType: EquipmentType;
  width: number;
  height: number;
  supplyShape: DuctShape;
  returnShape: DuctShape;
  supplyDiameter: number;
  returnDiameter: number;
  supplyWidth: number;
  supplyHeight: number;
  returnWidth: number;
  returnHeight: number;
};

export type PascalHvacNode = PascalDuctSegment | PascalDuctFitting | PascalDuctTerminal | PascalHvacEquipment;
export type PascalHvacNodeType = PascalHvacNode["type"];

export type PascalLevel = NodeBase & {
  type: "level";
  level: number;
  baseElevation: number;
  height: number | null;
};

/** The subset of a Pascal scene the adapter reasons about. */
export type PascalScene = {
  hvacNodes: ReadonlyMap<string, PascalHvacNode>;
  levels: ReadonlyMap<string, PascalLevel>;
  /** Parent id for every node in the scene, HVAC or not, for level lookup. */
  parentIds: ReadonlyMap<string, string | null>;
  /** Scene roots when the input carries `rootNodeIds`; `null` for a bare nodes dictionary. */
  rootNodeIds: readonly string[] | null;
  nodeCount: number;
};

export const HVAC_NODE_TYPES: readonly PascalHvacNodeType[] = ["duct-segment", "duct-fitting", "duct-terminal", "hvac-equipment"];

const DUCT_SHAPES: readonly DuctShape[] = ["round", "rect", "oval"];
const SYSTEMS: readonly PascalSystem[] = ["supply", "return"];
const TERMINAL_TYPES: readonly TerminalType[] = ["supply-register", "diffuser", "return-grille"];
const MOUNTS: readonly TerminalMount[] = ["floor", "ceiling", "wall"];
const EQUIPMENT_TYPES: readonly EquipmentType[] = ["furnace", "air-handler", "condenser"];

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidNode(id: string, field: string, detail: string): PascalAdapterError {
  return new PascalAdapterError("invalid-node", id, `Node ${id}: ${field} ${detail}.`);
}

function num(raw: Raw, id: string, field: string, fallback: number): number {
  const value = raw[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidNode(id, field, `must be a finite number, got ${JSON.stringify(value)}`);
  return value;
}

function optionalNum(raw: Raw, id: string, field: string): number | null {
  const value = raw[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidNode(id, field, `must be a finite number, got ${JSON.stringify(value)}`);
  return value;
}

function vec3(raw: Raw, id: string, field: string, fallback: Vec3): Vec3 {
  const value = raw[field];
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value) || value.length !== 3 || !value.every((component) => typeof component === "number" && Number.isFinite(component))) {
    throw invalidNode(id, field, "must be an [x, y, z] tuple of finite numbers");
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function oneOf<T extends string>(raw: Raw, id: string, field: string, allowed: readonly T[], fallback: T): T {
  const value = raw[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw invalidNode(id, field, `must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
  return value as T;
}

function metadataOf(raw: Raw, id: string): Readonly<Record<string, unknown>> {
  const value = raw.metadata;
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw invalidNode(id, "metadata", "must be an object");
  return value;
}

function parentIdOf(raw: Raw, id: string): string | null {
  const value = raw.parentId;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalidNode(id, "parentId", "must be a string or null");
  return value;
}

function readDuctSegment(raw: Raw, id: string, base: NodeBase): PascalDuctSegment {
  const rawPath = raw.path;
  if (!Array.isArray(rawPath) || rawPath.length < 2) throw invalidNode(id, "path", "must contain at least two [x, y, z] points");
  const path = rawPath.map((point, index) => {
    if (point === undefined || point === null) throw invalidNode(id, `path[${index}]`, "must be an [x, y, z] tuple");
    return vec3({ [`path[${index}]`]: point }, id, `path[${index}]`, [0, 0, 0]);
  });
  return {
    ...base,
    type: "duct-segment",
    path,
    shape: oneOf(raw, id, "shape", DUCT_SHAPES, "round"),
    diameter: num(raw, id, "diameter", 6),
    width: num(raw, id, "width", 14),
    height: num(raw, id, "height", 8),
    system: oneOf(raw, id, "system", SYSTEMS, "supply"),
  };
}

function readDuctFitting(raw: Raw, id: string, base: NodeBase): PascalDuctFitting {
  const fittingType = raw.fittingType ?? "elbow";
  if (typeof fittingType !== "string") throw invalidNode(id, "fittingType", "must be a string");
  return {
    ...base,
    type: "duct-fitting",
    position: vec3(raw, id, "position", [0, 0, 0]),
    rotation: vec3(raw, id, "rotation", [0, 0, 0]),
    fittingType,
    shape: oneOf(raw, id, "shape", DUCT_SHAPES, "rect"),
    shape2: oneOf(raw, id, "shape2", DUCT_SHAPES, "rect"),
    diameter: num(raw, id, "diameter", 6),
    diameter2: num(raw, id, "diameter2", 6),
    width: num(raw, id, "width", 14),
    height: num(raw, id, "height", 8),
    width2: num(raw, id, "width2", 14),
    height2: num(raw, id, "height2", 8),
    angle: num(raw, id, "angle", 90),
    branchAngle: num(raw, id, "branchAngle", 90),
    system: oneOf(raw, id, "system", SYSTEMS, "supply"),
  };
}

function readDuctTerminal(raw: Raw, id: string, base: NodeBase): PascalDuctTerminal {
  return {
    ...base,
    type: "duct-terminal",
    position: vec3(raw, id, "position", [0, 0, 0]),
    rotation: num(raw, id, "rotation", 0),
    terminalType: oneOf(raw, id, "terminalType", TERMINAL_TYPES, "supply-register"),
    mount: oneOf(raw, id, "mount", MOUNTS, "floor"),
    collarShape: oneOf(raw, id, "collarShape", DUCT_SHAPES, "round"),
    collarDiameter: num(raw, id, "collarDiameter", 6),
    collarWidth: num(raw, id, "collarWidth", 10),
    collarHeight: num(raw, id, "collarHeight", 6),
  };
}

function readHvacEquipment(raw: Raw, id: string, base: NodeBase): PascalHvacEquipment {
  return {
    ...base,
    type: "hvac-equipment",
    position: vec3(raw, id, "position", [0, 0, 0]),
    rotation: num(raw, id, "rotation", 0),
    equipmentType: oneOf(raw, id, "equipmentType", EQUIPMENT_TYPES, "furnace"),
    width: num(raw, id, "width", 0.56),
    height: num(raw, id, "height", 1.1),
    supplyShape: oneOf(raw, id, "supplyShape", DUCT_SHAPES, "round"),
    returnShape: oneOf(raw, id, "returnShape", DUCT_SHAPES, "round"),
    supplyDiameter: num(raw, id, "supplyDiameter", 8),
    returnDiameter: num(raw, id, "returnDiameter", 8),
    supplyWidth: num(raw, id, "supplyWidth", 12),
    supplyHeight: num(raw, id, "supplyHeight", 8),
    returnWidth: num(raw, id, "returnWidth", 14),
    returnHeight: num(raw, id, "returnHeight", 8),
  };
}

function readLevel(raw: Raw, id: string, base: NodeBase): PascalLevel {
  return {
    ...base,
    type: "level",
    level: num(raw, id, "level", 0),
    baseElevation: num(raw, id, "baseElevation", 0),
    height: optionalNum(raw, id, "height"),
  };
}

function nodesRecord(input: unknown): { nodes: Raw; rootNodeIds: readonly string[] | null } {
  let value: unknown = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new PascalAdapterError("invalid-json", null, `Scene is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isRecord(value)) throw new PascalAdapterError("invalid-scene", null, "Scene must be an object with a nodes dictionary.");
  // `export_json` returns `{ json: "<scene>" }`; unwrap it.
  if (typeof value.json === "string" && value.nodes === undefined) return nodesRecord(value.json);
  const rootNodeIds = Array.isArray(value.rootNodeIds) ? value.rootNodeIds.filter((id): id is string => typeof id === "string") : null;
  const nodes = value.nodes;
  if (Array.isArray(nodes)) {
    const record: Raw = {};
    for (const [index, node] of nodes.entries()) {
      if (!isRecord(node) || typeof node.id !== "string") throw new PascalAdapterError("invalid-scene", null, `nodes[${index}] must be an object with a string id.`);
      record[node.id] = node;
    }
    return { nodes: record, rootNodeIds };
  }
  if (!isRecord(nodes)) throw new PascalAdapterError("invalid-scene", null, "Scene must contain a nodes dictionary keyed by node id.");
  return { nodes, rootNodeIds };
}

/**
 * Read a Pascal scene from `export_json` / `get_scene` output, a saved scene
 * file, or a JSON string. Non-HVAC nodes are kept only for parent lookup.
 * Missing HVAC fields take Pascal's schema defaults; present but malformed
 * fields raise a typed `PascalAdapterError`.
 */
export function readPascalScene(input: unknown): PascalScene {
  const { nodes, rootNodeIds } = nodesRecord(input);
  const hvacNodes = new Map<string, PascalHvacNode>();
  const levels = new Map<string, PascalLevel>();
  const parentIds = new Map<string, string | null>();
  let nodeCount = 0;
  for (const [key, raw] of Object.entries(nodes)) {
    if (!isRecord(raw)) throw new PascalAdapterError("invalid-scene", key, `Node ${key} must be an object.`);
    const id = typeof raw.id === "string" ? raw.id : key;
    nodeCount += 1;
    const base: NodeBase = { id, parentId: parentIdOf(raw, id), metadata: metadataOf(raw, id) };
    parentIds.set(id, base.parentId);
    switch (raw.type) {
      case "duct-segment":
        hvacNodes.set(id, readDuctSegment(raw, id, base));
        break;
      case "duct-fitting":
        hvacNodes.set(id, readDuctFitting(raw, id, base));
        break;
      case "duct-terminal":
        hvacNodes.set(id, readDuctTerminal(raw, id, base));
        break;
      case "hvac-equipment":
        hvacNodes.set(id, readHvacEquipment(raw, id, base));
        break;
      case "level":
        levels.set(id, readLevel(raw, id, base));
        break;
      default:
        break;
    }
  }
  return { hvacNodes, levels, parentIds, rootNodeIds, nodeCount };
}
