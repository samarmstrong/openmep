import {
  DuctSizingError,
  STANDARD_ROUND_DIAMETERS_IN,
  recommendedMaxVelocityFpm,
  roundDuctFrictionRate,
  roundDuctVelocityFpm,
  type AirflowType,
  type DuctRole,
  type RoundDuctSize,
} from "./round-duct.js";

export type DuctSizeStatus = "ok" | "undersized" | "oversized";

export type RoundDuctSizeComparisonInput = {
  /** Actual round diameter, or the ASHRAE circular equivalent of a rect/oval section, in inches. */
  actualDiameterIn: number;
  recommended: RoundDuctSize;
  /** Supplying both enables the velocity-cap check. */
  airflowType?: AirflowType;
  role?: DuctRole;
};

export type RoundDuctSizeComparison = {
  status: DuctSizeStatus;
  actualDiameterIn: number;
  recommendedDiameterIn: number;
  /** Smallest diameter that meets the friction and velocity constraints. */
  requiredDiameterIn: number;
  actualVelocityFpm: number;
  actualFrictionRatePer100ft: number;
  maxVelocityFpm: number | null;
  velocityExceeded: boolean;
};

/**
 * Compare an existing duct against an equal-friction recommendation.
 * `undersized` when the actual diameter is below the exact required
 * diameter (the friction or velocity limit is exceeded); `oversized` when
 * it is at least one full standard size above the recommended standard
 * diameter; `ok` otherwise.
 */
export function compareRoundDuctSize(input: RoundDuctSizeComparisonInput): RoundDuctSizeComparison {
  const { actualDiameterIn, recommended } = input;
  if (!Number.isFinite(actualDiameterIn) || actualDiameterIn <= 0) {
    throw new DuctSizingError("invalid-diameter", actualDiameterIn, `actualDiameterIn must be a positive finite number, got ${actualDiameterIn}.`);
  }
  const nextStandard = STANDARD_ROUND_DIAMETERS_IN.find((diameter) => diameter > recommended.standardDiameterIn);
  const epsilon = 1e-9;
  let status: DuctSizeStatus = "ok";
  if (actualDiameterIn < recommended.exactDiameterIn - epsilon) status = "undersized";
  else if (nextStandard !== undefined && actualDiameterIn >= nextStandard - epsilon) status = "oversized";
  const maxVelocityFpm =
    input.airflowType !== undefined && input.role !== undefined
      ? recommendedMaxVelocityFpm(input.airflowType, input.role)
      : null;
  const actualVelocityFpm = roundDuctVelocityFpm(recommended.cfm, actualDiameterIn);
  return {
    status,
    actualDiameterIn,
    recommendedDiameterIn: recommended.standardDiameterIn,
    requiredDiameterIn: recommended.exactDiameterIn,
    actualVelocityFpm,
    actualFrictionRatePer100ft: roundDuctFrictionRate(recommended.cfm, actualDiameterIn),
    maxVelocityFpm,
    velocityExceeded: maxVelocityFpm !== null && actualVelocityFpm > maxVelocityFpm + epsilon,
  };
}
