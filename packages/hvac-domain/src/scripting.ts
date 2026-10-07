import {
  NetworkInputError,
  parseNetworkDocument,
  parseNetworkInput,
  sizeNetworkDocument,
  sizeNetworkInput,
  sizeSingleDuct,
  type ExistingSection,
  type NetworkDocument,
  type NetworkItemInput,
  type NetworkSizingOptions,
  type NetworkSizingResult,
  type SingleDuctInput,
  type SingleDuctResult,
} from "./cli.js";
import { DuctNetworkError, FRICTION_RATE_RANGE_PER_100FT, SIZED_AIRFLOW_TYPES, type FanStatic, type SizedAirflowType } from "./duct-network.js";
import { flatOvalEquivalentDiameterIn, rectangularEquivalentDiameterIn } from "./equivalent-diameter.js";
import { PortGraphError, connectCoincidentPorts, type PortGraphOptions, type PortRef } from "./port-graph.js";
import {
  DEFAULT_FRICTION_RATE_PER_100FT,
  DuctSizingError,
  STANDARD_ROUND_DIAMETERS_IN,
  recommendedMaxVelocityFpm,
  roundDuctFrictionRate,
  roundDuctVelocityFpm,
  type DuctRole,
} from "./round-duct.js";

/** Kept equal to package.json `version` (checked by a test). */
export const OPENMEP_VERSION = "0.6.0";

/** Any error the engine raises on bad input or an unsizeable duct. All carry a stable `code`. */
export type EngineError = DuctSizingError | DuctNetworkError | NetworkInputError | PortGraphError;

/** `true` for the engine's typed errors; anything else is a bug in the caller or the engine. */
export function isEngineError(error: unknown): error is EngineError {
  return (
    error instanceof DuctSizingError ||
    error instanceof DuctNetworkError ||
    error instanceof NetworkInputError ||
    error instanceof PortGraphError
  );
}

/** A `sizeDuct` input whose existing section is required, so the result always carries a grade. */
export type GradeDuctInput = Omit<SingleDuctInput, "existing"> & { existing: ExistingSection };
export type GradeDuctResult = SingleDuctResult & { existing: NonNullable<SingleDuctResult["existing"]> };

/**
 * Return a copy of `items` where every segment the engine sized carries its
 * recommended standard round diameter as `existing`. Unsized segments and
 * all other items are returned unchanged. Use after `sizeNetwork` to produce
 * a patched document, then re-run `sizeNetwork` on it to prove no
 * `undersized` finding remains.
 */
export function applySizes(items: readonly NetworkItemInput[], result: NetworkSizingResult): NetworkItemInput[] {
  const recommended = new Map(result.segments.map((segment) => [segment.elementRef, segment.recommended.standardDiameterIn]));
  return items.map((item) => {
    if (item.kind !== "segment") return item;
    const diameterIn = recommended.get(item.elementRef);
    if (diameterIn === undefined) return item;
    return { ...item, existing: { shape: "round", diameterIn } };
  });
}

/**
 * The scripting surface: one namespace with stable names an agent can call
 * from a short script. Every function is pure and synchronous. Airflow is a
 * design input; nothing here estimates CFM.
 */
export const openmep = {
  version: OPENMEP_VERSION,

  /** Size one round duct for an airflow; grade `existing` if given. */
  sizeDuct(input: SingleDuctInput): SingleDuctResult {
    return sizeSingleDuct(input);
  },

  /** Grade an existing round, rect, or oval section against the equal-friction recommendation. */
  gradeDuct(input: GradeDuctInput): GradeDuctResult {
    return sizeSingleDuct(input) as GradeDuctResult;
  },

  /**
   * Validate and size a network document: a JSON array of items,
   * `{ items, fan? }`, or an already-typed `NetworkItemInput[]`. Propagates
   * terminal CFM to equipment per system and grades segments that describe
   * `existing`. With `fan` (in the document or in `options`), the friction
   * rate is derived from available static pressure over the total effective
   * length, Manual D style; otherwise the fixed default rate is used.
   */
  sizeNetwork(input: unknown, options: NetworkSizingOptions = {}): NetworkSizingResult {
    const document = parseNetworkDocument(input);
    return sizeNetworkDocument({ items: document.items, fan: options.fan === undefined ? document.fan : options.fan });
  },

  /** Validate a network document's items without sizing. Throws `NetworkInputError` with a JSON path. */
  parseNetwork(input: unknown): NetworkItemInput[] {
    return parseNetworkInput(input);
  },

  /** Validate a network document (`{ items, fan? }` or an array) without sizing. */
  parseNetworkDocument(input: unknown): NetworkDocument {
    return parseNetworkDocument(input);
  },

  /**
   * Manual D friction-rate arithmetic on its own: available static = external
   * static − Σ component losses; FR = available static × 100 / TEL.
   */
  frictionRateFromStatic(input: FanStatic & { totalEffectiveLengthFt: number }): { availableStaticInWg: number; frictionRatePer100ft: number; inRange: boolean } {
    const losses = Object.values(input.componentLossesInWg ?? {}).reduce((sum, loss) => sum + loss, 0);
    const availableStaticInWg = input.externalStaticInWg - losses;
    if (!(availableStaticInWg > 0)) throw new DuctNetworkError("non-positive-available-static", "fan", `Component losses (${losses}) consume the external static pressure (${input.externalStaticInWg}).`);
    if (!(input.totalEffectiveLengthFt > 0)) throw new DuctNetworkError("missing-length", "fan", "totalEffectiveLengthFt must be positive.");
    const round4 = (value: number): number => Math.round(value * 10000) / 10000;
    const frictionRatePer100ft = round4((availableStaticInWg * 100) / input.totalEffectiveLengthFt);
    return { availableStaticInWg: round4(availableStaticInWg), frictionRatePer100ft, inRange: frictionRatePer100ft >= FRICTION_RATE_RANGE_PER_100FT.min && frictionRatePer100ft <= FRICTION_RATE_RANGE_PER_100FT.max };
  },

  applySizes,

  /** Rebuild `connectedItemRefs` from ports listed in one metric frame (default tolerance 5 cm). */
  connectPorts(ports: readonly PortRef[], options?: PortGraphOptions): ReadonlyMap<string, readonly string[]> {
    return connectCoincidentPorts(ports, options);
  },

  /** ASHRAE circular equivalent of a round, rect, or oval section, in inches. */
  equivalentDiameterIn(section: ExistingSection): number {
    if (section.shape === "round") return section.diameterIn;
    if (section.shape === "rect") return rectangularEquivalentDiameterIn(section.widthIn, section.heightIn);
    return flatOvalEquivalentDiameterIn(section.widthIn, section.heightIn);
  },

  /** Velocity (fpm) of `cfm` through a round duct of `diameterIn`. */
  velocityFpm(cfm: number, diameterIn: number): number {
    return roundDuctVelocityFpm(cfm, diameterIn);
  },

  /** Friction rate (in. w.g. per 100 ft) of `cfm` through a round duct of `diameterIn`. */
  frictionRatePer100ft(cfm: number, diameterIn: number): number {
    return roundDuctFrictionRate(cfm, diameterIn);
  },

  /** Recommended maximum velocity for a system and duct role. */
  maxVelocityFpm(airflowType: SizedAirflowType, role: DuctRole): number {
    return recommendedMaxVelocityFpm(airflowType, role);
  },

  constants: {
    frictionRatePer100ft: DEFAULT_FRICTION_RATE_PER_100FT,
    frictionRateRangePer100ft: FRICTION_RATE_RANGE_PER_100FT,
    standardRoundDiametersIn: STANDARD_ROUND_DIAMETERS_IN,
    airflowTypes: SIZED_AIRFLOW_TYPES,
    roles: ["main", "branch", "runout"] as const satisfies readonly DuctRole[],
  },

  errors: { DuctSizingError, DuctNetworkError, NetworkInputError, PortGraphError },
  isEngineError,
} as const;

export type OpenMep = typeof openmep;
