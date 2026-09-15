/** Default mating tolerance for typed ports, in metres (Pascal Editor uses 5 cm). */
export const DEFAULT_PORT_COINCIDENCE_TOLERANCE_M = 0.05;

/**
 * A connection point on a host item, in one shared metric frame. `system`
 * is an optional compatibility tag (for example `supply` or `return`);
 * two ports connect only when their tags match or one is absent.
 */
export type PortRef = {
  itemRef: string;
  position: readonly [number, number, number];
  system?: string | null;
};

export type PortGraphOptions = {
  toleranceM?: number;
};

export type PortGraphErrorCode = "invalid-tolerance" | "invalid-position";

export class PortGraphError extends Error {
  readonly code: PortGraphErrorCode;
  readonly itemRef: string | null;
  constructor(code: PortGraphErrorCode, itemRef: string | null, message: string) {
    super(message);
    this.name = "PortGraphError";
    this.code = code;
    this.itemRef = itemRef;
  }
}

/**
 * Connect items whose ports coincide within a tolerance. Host-agnostic: any
 * editor that can list its items' ports in one metric frame can rebuild
 * connectivity with this and feed the result to `recommendSupplyDuctSegments`.
 * Returns each item's sorted, de-duplicated connected item refs (never the
 * item itself). Items with no coincident ports are present with `[]`.
 */
export function connectCoincidentPorts(
  ports: readonly PortRef[],
  options: PortGraphOptions = {},
): ReadonlyMap<string, readonly string[]> {
  const toleranceM = options.toleranceM ?? DEFAULT_PORT_COINCIDENCE_TOLERANCE_M;
  if (!Number.isFinite(toleranceM) || toleranceM < 0) {
    throw new PortGraphError("invalid-tolerance", null, `toleranceM must be a finite non-negative number, got ${toleranceM}.`);
  }
  const connected = new Map<string, Set<string>>();
  for (const port of ports) {
    if (port.position.length !== 3 || !port.position.every(Number.isFinite)) {
      throw new PortGraphError("invalid-position", port.itemRef, `Port on ${port.itemRef} has a non-finite position.`);
    }
    if (!connected.has(port.itemRef)) connected.set(port.itemRef, new Set());
  }
  const toleranceSq = toleranceM * toleranceM;
  for (let i = 0; i < ports.length; i++) {
    const a = ports[i]!;
    for (let j = i + 1; j < ports.length; j++) {
      const b = ports[j]!;
      if (a.itemRef === b.itemRef) continue;
      if (a.system && b.system && a.system !== b.system) continue;
      const dx = a.position[0] - b.position[0];
      const dy = a.position[1] - b.position[1];
      const dz = a.position[2] - b.position[2];
      if (dx * dx + dy * dy + dz * dz <= toleranceSq) {
        connected.get(a.itemRef)!.add(b.itemRef);
        connected.get(b.itemRef)!.add(a.itemRef);
      }
    }
  }
  const result = new Map<string, readonly string[]>();
  for (const itemRef of [...connected.keys()].sort()) {
    result.set(itemRef, [...connected.get(itemRef)!].sort());
  }
  return result;
}
