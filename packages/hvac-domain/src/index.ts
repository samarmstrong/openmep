export {
  DEFAULT_FRICTION_RATE_PER_100FT,
  STANDARD_ROUND_DIAMETERS_IN,
  recommendedMaxVelocityFpm,
  roundDuctFrictionRate,
  roundDuctVelocityFpm,
  sizeDuctForAirflow,
  sizeRoundDuct,
  sizeSupplyRoundDuct,
  DuctSizingError,
} from "./round-duct.js";
export type {
  AirflowType,
  DuctForAirflowSizingInput,
  DuctRole,
  DuctSizingErrorCode,
  RoundDuctSize,
  RoundDuctSizingInput,
  SupplyRoundDuctSizingInput,
} from "./round-duct.js";

export {
  DuctNetworkError,
  recommendSupplyDuctSegments,
} from "./supply-network.js";
export type {
  DuctNetworkErrorCode,
  DuctNetworkFinding,
  NetworkItem,
  NetworkNode,
  NetworkSegment,
  SupplyDuctNetworkResult,
  SupplyDuctSegmentRecommendation,
} from "./supply-network.js";
