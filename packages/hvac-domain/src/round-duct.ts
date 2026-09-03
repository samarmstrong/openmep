/** Default low-velocity commercial friction rate, in. w.g. per 100 ft. */
export const DEFAULT_FRICTION_RATE_PER_100FT = 0.08;

/** Standard spiral/round galvanized duct diameters (inches). */
export const STANDARD_ROUND_DIAMETERS_IN = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 30,
  32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60,
] as const;

const FRICTION_COEFFICIENT = 0.109136;
const FRICTION_FLOW_EXPONENT = 1.9;
const FRICTION_DIAMETER_EXPONENT = 5.02;

export type DuctRole = "main" | "branch" | "runout";
export type AirflowType = "supply" | "return" | "exhaust" | "outside-air" | "unknown";
export type SupplyAirflowType = "supply";
export type DuctSizingErrorCode =
  | "invalid-airflow"
  | "invalid-diameter"
  | "invalid-friction-rate"
  | "invalid-velocity"
  | "unsupported-airflow-type"
  | "unsupported-duct-role"
  | "diameter-exceeds-standard-range";

export class DuctSizingError extends Error {
  readonly code: DuctSizingErrorCode;
  readonly value: number | string;

  constructor(code: DuctSizingErrorCode, value: number | string, message: string) {
    super(message);
    this.name = "DuctSizingError";
    this.code = code;
    this.value = value;
  }
}

export type RoundDuctSize = {
  cfm: number;
  exactDiameterIn: number;
  standardDiameterIn: number;
  velocityFpm: number;
  frictionRatePer100ft: number;
  targetFrictionRatePer100ft: number;
  governingConstraint: "friction" | "velocity";
};

export type RoundDuctSizingInput = {
  cfm: number;
  frictionRatePer100ft?: number;
  maxVelocityFpm?: number | null;
};

export type SupplyRoundDuctSizingInput = {
  cfm: number;
  role: DuctRole;
  frictionRatePer100ft?: number;
};

export type DuctForAirflowSizingInput = SupplyRoundDuctSizingInput & {
  airflowType: AirflowType;
};

function assertPositiveFinite(
  value: number,
  code: Extract<DuctSizingErrorCode, "invalid-airflow" | "invalid-diameter" | "invalid-friction-rate" | "invalid-velocity">,
  label: string,
): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new DuctSizingError(code, value, `${label} must be a positive finite number, got ${value}.`);
  }
}

/** Friction rate (in. w.g. per 100 ft) for airflow through a round duct. */
export function roundDuctFrictionRate(cfm: number, diameterIn: number): number {
  assertPositiveFinite(cfm, "invalid-airflow", "cfm");
  assertPositiveFinite(diameterIn, "invalid-diameter", "diameterIn");
  return FRICTION_COEFFICIENT * Math.pow(cfm, FRICTION_FLOW_EXPONENT) / Math.pow(diameterIn, FRICTION_DIAMETER_EXPONENT);
}

/** Air velocity (fpm) for airflow through a round duct. */
export function roundDuctVelocityFpm(cfm: number, diameterIn: number): number {
  assertPositiveFinite(cfm, "invalid-airflow", "cfm");
  assertPositiveFinite(diameterIn, "invalid-diameter", "diameterIn");
  return cfm / ((Math.PI / 4) * Math.pow(diameterIn / 12, 2));
}

const RECOMMENDED_MAX_VELOCITY_FPM: Record<Exclude<AirflowType, "unknown">, Record<DuctRole, number>> = {
  supply: { main: 1300, branch: 900, runout: 700 },
  return: { main: 1200, branch: 800, runout: 600 },
  exhaust: { main: 1500, branch: 1000, runout: 800 },
  "outside-air": { main: 1000, branch: 800, runout: 600 },
};

/** Recommended maximum velocity (fpm) by classified airflow and role. */
export function recommendedMaxVelocityFpm(airflowType: AirflowType, role: DuctRole): number {
  if (airflowType === "unknown" || !Object.hasOwn(RECOMMENDED_MAX_VELOCITY_FPM, airflowType)) {
    throw new DuctSizingError("unsupported-airflow-type", airflowType, "Classify the airflow before selecting a velocity cap.");
  }
  const velocities = RECOMMENDED_MAX_VELOCITY_FPM[airflowType];
  if (!Object.hasOwn(velocities, role)) {
    throw new DuctSizingError("unsupported-duct-role", role, `Unknown duct role ${role}.`);
  }
  return velocities[role];
}

/** Size a round duct by equal friction, optionally enforcing a velocity cap. */
export function sizeRoundDuct(input: RoundDuctSizingInput): RoundDuctSize {
  const targetFrictionRatePer100ft = input.frictionRatePer100ft ?? DEFAULT_FRICTION_RATE_PER_100FT;
  assertPositiveFinite(input.cfm, "invalid-airflow", "cfm");
  assertPositiveFinite(targetFrictionRatePer100ft, "invalid-friction-rate", "frictionRatePer100ft");
  let exactDiameterIn = Math.pow(
    FRICTION_COEFFICIENT * Math.pow(input.cfm, FRICTION_FLOW_EXPONENT) / targetFrictionRatePer100ft,
    1 / FRICTION_DIAMETER_EXPONENT,
  );
  let governingConstraint: RoundDuctSize["governingConstraint"] = "friction";
  if (input.maxVelocityFpm != null) {
    assertPositiveFinite(input.maxVelocityFpm, "invalid-velocity", "maxVelocityFpm");
    const velocityDiameter = 12 * Math.sqrt((4 * (input.cfm / input.maxVelocityFpm)) / Math.PI);
    if (velocityDiameter > exactDiameterIn) {
      exactDiameterIn = velocityDiameter;
      governingConstraint = "velocity";
    }
  }
  const standardDiameterIn = STANDARD_ROUND_DIAMETERS_IN.find((diameter) => diameter >= exactDiameterIn);
  if (standardDiameterIn === undefined) {
    const maximum = STANDARD_ROUND_DIAMETERS_IN.at(-1)!;
    throw new DuctSizingError("diameter-exceeds-standard-range", exactDiameterIn, `Required diameter ${exactDiameterIn.toFixed(1)} in exceeds the largest standard round duct (${maximum} in).`);
  }
  return {
    cfm: input.cfm,
    exactDiameterIn,
    standardDiameterIn,
    velocityFpm: roundDuctVelocityFpm(input.cfm, standardDiameterIn),
    frictionRatePer100ft: roundDuctFrictionRate(input.cfm, standardDiameterIn),
    targetFrictionRatePer100ft,
    governingConstraint,
  };
}

/** Size a supply round duct using the published role-based velocity cap. */
export function sizeSupplyRoundDuct(input: SupplyRoundDuctSizingInput): RoundDuctSize {
  return sizeDuctForAirflow({ ...input, airflowType: "supply" });
}

/** Size a round duct using the role-based velocity cap for classified airflow. */
export function sizeDuctForAirflow(input: DuctForAirflowSizingInput): RoundDuctSize {
  return sizeRoundDuct({
    cfm: input.cfm,
    frictionRatePer100ft: input.frictionRatePer100ft,
    maxVelocityFpm: recommendedMaxVelocityFpm(input.airflowType, input.role),
  });
}
