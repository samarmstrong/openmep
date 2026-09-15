import type {
  DuctShape,
  PascalDuctFitting,
  PascalDuctSegment,
  PascalDuctTerminal,
  PascalHvacEquipment,
  PascalHvacNode,
  PascalScene,
  PascalSystem,
  Vec3,
} from "./scene.js";

/**
 * Port geometry re-implemented from Pascal Editor's node definitions
 * (`packages/nodes/src/{duct-segment,duct-fitting,duct-terminal,hvac-equipment}`,
 * MIT, pascalorg/editor). Positions are level-local metres; `direction`
 * points out of the node toward whatever should mate with it.
 */
export type PascalPort = {
  nodeId: string;
  portId: string;
  position: Vec3;
  direction: Vec3;
  /** Area-equivalent round size Pascal advertises at the port, inches. */
  diameterIn: number;
  system: PascalSystem;
};

const INCHES_TO_METERS = 0.0254;
/** Collar stub length behind a terminal face, metres. */
export const TERMINAL_COLLAR_LENGTH_M = 0.12;
/** Pascal's storey height fallback for levels without a stored height, metres. */
export const DEFAULT_LEVEL_HEIGHT_M = 2.5;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length < 1e-12 ? [1, 0, 0] : [v[0] / length, v[1] / length, v[2] / length];
};
const rotateX = (v: Vec3, t: number): Vec3 => [v[0], v[1] * Math.cos(t) - v[2] * Math.sin(t), v[1] * Math.sin(t) + v[2] * Math.cos(t)];
const rotateY = (v: Vec3, t: number): Vec3 => [v[0] * Math.cos(t) + v[2] * Math.sin(t), v[1], -v[0] * Math.sin(t) + v[2] * Math.cos(t)];
const rotateZ = (v: Vec3, t: number): Vec3 => [v[0] * Math.cos(t) - v[1] * Math.sin(t), v[0] * Math.sin(t) + v[1] * Math.cos(t), v[2]];
/** three.js `Euler` order XYZ: R = Rx · Ry · Rz. */
const applyEulerXYZ = (v: Vec3, e: Vec3): Vec3 => rotateX(rotateY(rotateZ(v, e[2]), e[1]), e[0]);

/**
 * The round size Pascal advertises for a shaped section so mating runs pick
 * a sensible diameter: area-equivalent, not the ASHRAE friction equivalent.
 */
export function areaEquivalentDiameterIn(shape: DuctShape, diameterIn: number, widthIn: number, heightIn: number): number {
  if (shape === "rect") return 2 * Math.sqrt((widthIn * heightIn) / Math.PI);
  if (shape === "oval") {
    const minor = Math.min(widthIn, heightIn);
    const major = Math.max(widthIn, heightIn);
    const area = (major - minor) * minor + Math.PI * (minor / 2) ** 2;
    return 2 * Math.sqrt(area / Math.PI);
  }
  return diameterIn;
}

export function fittingLegLengthM(diameterIn: number): number {
  return Math.max(0.14, ((diameterIn * INCHES_TO_METERS) / 2) * 2.5);
}

export function ductSegmentPorts(node: PascalDuctSegment): PascalPort[] {
  const first = node.path[0]!;
  const second = node.path[1]!;
  const last = node.path[node.path.length - 1]!;
  const prev = node.path[node.path.length - 2]!;
  const diameterIn = areaEquivalentDiameterIn(node.shape, node.diameter, node.width, node.height);
  const away = (a: Vec3, b: Vec3): Vec3 => normalize([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
  return [
    { nodeId: node.id, portId: "start", position: first, direction: away(first, second), diameterIn, system: node.system },
    { nodeId: node.id, portId: "end", position: last, direction: away(last, prev), diameterIn, system: node.system },
  ];
}

export function terminalSystem(node: PascalDuctTerminal): PascalSystem {
  return node.terminalType === "return-grille" ? "return" : "supply";
}

export function ductTerminalPorts(node: PascalDuctTerminal): PascalPort[] {
  const mount = (v: Vec3): Vec3 => (node.mount === "ceiling" ? rotateX(v, Math.PI) : node.mount === "wall" ? rotateX(v, Math.PI / 2) : v);
  const transform = (v: Vec3): Vec3 => rotateY(mount(v), node.rotation);
  return [
    {
      nodeId: node.id,
      portId: "collar",
      position: add(node.position, transform([0, -TERMINAL_COLLAR_LENGTH_M, 0])),
      direction: normalize(transform([0, -1, 0])),
      diameterIn: areaEquivalentDiameterIn(node.collarShape, node.collarDiameter, node.collarWidth, node.collarHeight),
      system: terminalSystem(node),
    },
  ];
}

export function hvacEquipmentPorts(node: PascalHvacEquipment): PascalPort[] {
  if (node.equipmentType === "condenser") return [];
  const place = (local: Vec3): Vec3 => add(node.position, rotateY(local, node.rotation));
  const aim = (local: Vec3): Vec3 => normalize(rotateY(local, node.rotation));
  return [
    {
      nodeId: node.id,
      portId: "supply",
      position: place([0, node.height, 0]),
      direction: aim([0, 1, 0]),
      diameterIn: areaEquivalentDiameterIn(node.supplyShape, node.supplyDiameter, node.supplyWidth, node.supplyHeight),
      system: "supply",
    },
    {
      nodeId: node.id,
      portId: "return",
      position: place([-node.width / 2, node.height * 0.35, 0]),
      direction: aim([-1, 0, 0]),
      diameterIn: areaEquivalentDiameterIn(node.returnShape, node.returnDiameter, node.returnWidth, node.returnHeight),
      system: "return",
    },
  ];
}

type LocalPort = { portId: string; position: Vec3; direction: Vec3; diameterIn: number };

function localFittingPorts(node: PascalDuctFitting): LocalPort[] | null {
  const main = fittingLegLengthM(node.diameter);
  const inlet: LocalPort = { portId: "inlet", position: [-main, 0, 0], direction: [-1, 0, 0], diameterIn: node.diameter };
  switch (node.fittingType) {
    case "access-panel":
      return [];
    case "end-cap":
      return [{ ...inlet, position: [-0.025, 0, 0] }];
    case "damper":
    case "coupling":
      return [
        { ...inlet, position: [-0.1, 0, 0] },
        { portId: "outlet", position: [0.1, 0, 0], direction: [1, 0, 0], diameterIn: node.diameter },
      ];
    case "elbow": {
      const theta = (node.angle * Math.PI) / 180;
      const out: Vec3 = [Math.cos(theta), 0, Math.sin(theta)];
      return [inlet, { portId: "outlet", position: scale(out, main), direction: out, diameterIn: node.diameter }];
    }
    case "tee": {
      const branch = fittingLegLengthM(node.diameter2);
      const phi = (node.branchAngle * Math.PI) / 180;
      const branchDir: Vec3 = [Math.cos(phi), 0, Math.sin(phi)];
      return [
        inlet,
        { portId: "outlet", position: [main, 0, 0], direction: [1, 0, 0], diameterIn: node.diameter },
        { portId: "branch", position: scale(branchDir, branch), direction: branchDir, diameterIn: node.diameter2 },
      ];
    }
    case "cross": {
      const branch = fittingLegLengthM(node.diameter2);
      return [
        inlet,
        { portId: "outlet", position: [main, 0, 0], direction: [1, 0, 0], diameterIn: node.diameter },
        { portId: "branch", position: [0, 0, branch], direction: [0, 0, 1], diameterIn: node.diameter2 },
        { portId: "branch2", position: [0, 0, -branch], direction: [0, 0, -1], diameterIn: node.diameter2 },
      ];
    }
    case "reducer":
    case "transition":
      return [inlet, { portId: "outlet", position: [main, 0, 0], direction: [1, 0, 0], diameterIn: node.diameter2 }];
    default:
      return null;
  }
}

/** Returns `null` for a fitting type this adapter does not know. */
export function ductFittingPorts(node: PascalDuctFitting): PascalPort[] | null {
  const local = localFittingPorts(node);
  if (local === null) return null;
  return local.map((port) => ({
    nodeId: node.id,
    portId: port.portId,
    position: add(node.position, applyEulerXYZ(port.position, node.rotation)),
    direction: normalize(applyEulerXYZ(port.direction, node.rotation)),
    diameterIn: port.diameterIn,
    system: node.system,
  }));
}

/** Level-local ports for any HVAC node; `null` only for unknown fitting types. */
export function portsForNode(node: PascalHvacNode): PascalPort[] | null {
  switch (node.type) {
    case "duct-segment":
      return ductSegmentPorts(node);
    case "duct-fitting":
      return ductFittingPorts(node);
    case "duct-terminal":
      return ductTerminalPorts(node);
    case "hvac-equipment":
      return hvacEquipmentPorts(node);
  }
}

/**
 * World floor elevation per level, stacking storey heights per building the
 * way Pascal does (`services/storey.ts`): levels sorted by ordinal, each floor
 * at the previous top plus its own `baseElevation`.
 */
export function levelBaseElevations(scene: PascalScene): ReadonlyMap<string, number> {
  const levels = [...scene.levels.values()].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
  const cumulative = new Map<string | null, number>();
  const result = new Map<string, number>();
  for (const level of levels) {
    const baseY = (cumulative.get(level.parentId) ?? 0) + level.baseElevation;
    result.set(level.id, baseY);
    cumulative.set(level.parentId, baseY + (level.height ?? DEFAULT_LEVEL_HEIGHT_M));
  }
  return result;
}

/** The level a node ultimately sits on, or `null` when it is not under one. */
export function nodeLevelId(scene: PascalScene, nodeId: string): string | null {
  const visited = new Set<string>();
  let current: string | null = nodeId;
  while (current !== null && !visited.has(current)) {
    if (scene.levels.has(current)) return current;
    visited.add(current);
    current = scene.parentIds.get(current) ?? null;
  }
  return null;
}

/** Every HVAC port in the scene, lifted to world Y by its level's floor elevation. */
export function worldPorts(scene: PascalScene): { ports: PascalPort[]; unsupportedFittingIds: string[] } {
  const elevations = levelBaseElevations(scene);
  const ports: PascalPort[] = [];
  const unsupportedFittingIds: string[] = [];
  for (const node of [...scene.hvacNodes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const local = portsForNode(node);
    if (local === null) {
      unsupportedFittingIds.push(node.id);
      continue;
    }
    const levelId = nodeLevelId(scene, node.id);
    const baseY = levelId === null ? 0 : (elevations.get(levelId) ?? 0);
    for (const port of local) {
      ports.push(baseY === 0 ? port : { ...port, position: [port.position[0], port.position[1] + baseY, port.position[2]] });
    }
  }
  return { ports, unsupportedFittingIds };
}
