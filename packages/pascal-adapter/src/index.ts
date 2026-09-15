export { PascalAdapterError } from "./errors.js";
export type { PascalAdapterErrorCode } from "./errors.js";

export { HVAC_NODE_TYPES, readPascalScene } from "./scene.js";
export type {
  DuctShape,
  EquipmentType,
  PascalDuctFitting,
  PascalDuctSegment,
  PascalDuctTerminal,
  PascalHvacEquipment,
  PascalHvacNode,
  PascalHvacNodeType,
  PascalLevel,
  PascalScene,
  PascalSystem,
  TerminalMount,
  TerminalType,
  Vec3,
} from "./scene.js";

export {
  DEFAULT_LEVEL_HEIGHT_M,
  TERMINAL_COLLAR_LENGTH_M,
  areaEquivalentDiameterIn,
  ductFittingPorts,
  ductSegmentPorts,
  ductTerminalPorts,
  fittingLegLengthM,
  hvacEquipmentPorts,
  levelBaseElevations,
  nodeLevelId,
  portsForNode,
  terminalSystem,
  worldPorts,
} from "./ports.js";
export type { PascalPort } from "./ports.js";

export { DEFAULT_CFM_METADATA_KEY, buildPascalNetwork, readRequiredCfm } from "./network.js";
export type { BuildNetworkOptions, CfmReading, PascalFinding, PascalFindingCode, PascalFindingSeverity, PascalNetwork } from "./network.js";

export { DEFAULT_METADATA_KEY, PASCAL_DUCT_DIAMETER_RANGE_IN, sizePascalNetwork, sizePascalScene } from "./size.js";
export type { PascalSegmentSizing, PascalSizingOptions, PascalSizingResult, PascalSizingSummary, PascalUpdatePatch } from "./size.js";

export { connectPascalMcp, discoverPascalMcp, openPascalMcpSession, pascalMcpTransport, sizeThroughPascalMcp } from "./mcp.js";
export type {
  PascalApplyPatchResult,
  PascalMcpDiscovery,
  PascalMcpSession,
  PascalMcpSizeOptions,
  PascalMcpSizeOutcome,
  PascalMcpTarget,
  PascalMcpVerification,
} from "./mcp.js";

export { CLI_USAGE, mcpTargetFromFlags, runCli } from "./cli.js";
