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
  FRICTION_RATE_RANGE_PER_100FT,
  SIZED_AIRFLOW_TYPES,
  recommendDuctSegments,
  recommendSupplyDuctSegments,
} from "./duct-network.js";
export type {
  DesignFrictionRate,
  DuctNetworkErrorCode,
  DuctNetworkFinding,
  EffectivePath,
  FanStatic,
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

export { NetworkInputError, parseNetworkDocument, parseNetworkInput, readNetworkDocument, readNetworkInput, sizeNetworkDocument, sizeNetworkInput, sizeSingleDuct } from "./cli.js";
export type {
  ExistingSection,
  NetworkDocument,
  NetworkSizingOptions,
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

export { OPENMEP_VERSION, applySizes, isEngineError, openmep } from "./scripting.js";
export type { EngineError, GradeDuctInput, GradeDuctResult, OpenMep } from "./scripting.js";
