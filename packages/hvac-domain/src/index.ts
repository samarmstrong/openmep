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
  SIZED_AIRFLOW_TYPES,
  recommendDuctSegments,
  recommendSupplyDuctSegments,
} from "./duct-network.js";
export type {
  DuctNetworkErrorCode,
  DuctNetworkFinding,
  NetworkItem,
  NetworkNode,
  DuctNetworkOptions,
  DuctNetworkResult,
  DuctSegmentRecommendation,
  NetworkSegment,
  SizedAirflowType,
} from "./duct-network.js";

export {
  flatOvalEquivalentDiameterIn,
  rectangularEquivalentDiameterIn,
} from "./equivalent-diameter.js";

export {
  DEFAULT_PORT_COINCIDENCE_TOLERANCE_M,
  PortGraphError,
  connectCoincidentPorts,
} from "./port-graph.js";
export type { PortGraphErrorCode, PortGraphOptions, PortRef } from "./port-graph.js";

export { compareRoundDuctSize } from "./size-comparison.js";
export type {
  DuctSizeStatus,
  RoundDuctSizeComparison,
  RoundDuctSizeComparisonInput,
} from "./size-comparison.js";

export { NetworkInputError, parseNetworkInput, readNetworkInput, sizeNetworkInput, sizeSingleDuct } from "./cli.js";
export type {
  ExistingSection,
  NetworkFinding,
  NetworkFindingCode,
  NetworkInputErrorCode,
  NetworkItemInput,
  NetworkSegmentInput,
  NetworkSegmentSizing,
  NetworkSizingResult,
  SingleDuctInput,
  SingleDuctResult,
} from "./cli.js";
