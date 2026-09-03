export {
  SPACE_TYPES,
  SPACE_TYPE_KEYS,
  getSpaceType,
  tryGetSpaceType,
} from "./space-types";
export type { SpaceTypeEntry } from "./space-types";
export { classifyByName, classifySpaces } from "./classify";
export type { ClassifySpacesOptions, SpaceClassification } from "./classify";
export { createClaudeCodeClassifier } from "./classify-claude-code";
export type { ClaudeCodeClassifierOptions } from "./classify-claude-code";
export {
  computeVentilation,
  defaultOccupants,
  DEFAULT_ZONE_AIR_DISTRIBUTION_EFFECTIVENESS,
} from "./ventilation";
export type { VentilationInput, VentilationResult } from "./ventilation";
export { computeThermal, DEFAULT_SUPPLY_DELTA_T_F } from "./thermal";
export type { ThermalInput, ThermalResult } from "./thermal";
export { computeStoreyLoads } from "./calculate";
export type { StoreyLoadsInput } from "./calculate";
export {
  LoadInputCoverageError,
  assertLoadInputCoverage,
  summarizeLoadInputCoverage,
} from "./load-input-coverage";
export type { LoadInputCoverage } from "./load-input-coverage";
export { assignTerminalCfm } from "./terminal-cfm";
export type { TerminalCfmAssignment } from "./terminal-cfm";
export { validateMechanicalPlan } from "./mechanical-validator";
export type {
  ValidationCheck,
  ValidationFinding,
  ValidationReport,
  ValidateOptions,
} from "./mechanical-validator";
export { pointInPolygon, pointInRing, polygonOuterArea } from "./geometry-2d";
export {
  sizeRoundDuct,
  sizeDuctForAirflow,
  recommendedMaxVelocityFpm,
  roundDuctFrictionRate,
  roundDuctVelocityFpm,
  DEFAULT_FRICTION_RATE_PER_100FT,
  STANDARD_ROUND_DIAMETERS_IN,
  DuctSizingError,
} from "./duct-sizing";
export type {
  AirflowType,
  DuctRole,
  DuctSizingErrorCode,
  RoundDuctSize,
} from "./duct-sizing";
export { DuctNetworkError, recommendDuctSegmentSizes } from "./duct-network";
export type {
  DuctNetworkErrorCode,
  DuctNetworkFinding,
  DuctNetworkSizingResult,
  DuctSegmentRecommendation,
} from "./duct-network";
export {
  CLIMATE_ZONES,
  getClimateZone,
  getDesignConditions,
  resolveClimate,
} from "./climate";
export type {
  ClimateZone,
  DesignConditions,
  ResolvedClimate,
  SiteLocation,
} from "./climate";
export { classifyAssembly, getAssemblyDefaults } from "./assemblies";
export type {
  AssemblyClass,
  AssemblyDefaults,
  BoundaryExposure,
} from "./assemblies";
export { computeEnvelope, describeEnvelope } from "./envelope";
export type { EnvelopeInput, EnvelopeResult } from "./envelope";
