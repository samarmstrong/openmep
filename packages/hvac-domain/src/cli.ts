import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { flatOvalEquivalentDiameterIn, rectangularEquivalentDiameterIn } from "./equivalent-diameter.js";
import { DuctSizingError, sizeDuctForAirflow, type AirflowType, type DuctRole, type RoundDuctSize } from "./round-duct.js";
import { compareRoundDuctSize, type RoundDuctSizeComparison } from "./size-comparison.js";
import { DuctNetworkError, recommendSupplyDuctSegments, type NetworkItem, type NetworkNode, type NetworkSegment } from "./supply-network.js";

export const CLI_USAGE = [
  "usage:",
  "  openmep-hvac size <network.json|-> [--out file] [--pretty] [--fail-on-findings]",
  "  openmep-hvac duct --cfm n [--role main|branch|runout] [--airflow supply|return|exhaust|outside-air] [--diameter-in n] [--pretty]",
  "",
  "size  sizes every supply run of a duct network from terminal requiredCfm and grades any existing",
  "      diameters. Input: a JSON array of NetworkItems, or { \"items\": [...] }. Segments may carry an",
  "      optional existing section: diameterIn (round) or shape rect|oval with widthIn and heightIn.",
  "duct  sizes one round duct for an airflow, optionally grading an existing diameter.",
  "No host, editor, or network connection is needed. Exit codes: 0 ok, 1 error findings with",
  "--fail-on-findings, 2 invalid input or engine error.",
].join("\n");

export type NetworkInputErrorCode = "invalid-json" | "invalid-item" | "invalid-argument";
export class NetworkInputError extends Error {
  readonly code: NetworkInputErrorCode;
  /** JSON path of the offending value, e.g. `items[2].requiredCfm`; `null` for whole-input errors. */
  readonly path: string | null;
  constructor(code: NetworkInputErrorCode, path: string | null, message: string) {
    super(message);
    this.name = "NetworkInputError";
    this.code = code;
    this.path = path;
  }
}

export type ExistingSection = { shape: "round"; diameterIn: number } | { shape: "rect" | "oval"; widthIn: number; heightIn: number };
/** A `NetworkSegment` that may describe its existing section for grading. */
export type NetworkSegmentInput = NetworkSegment & { existing?: ExistingSection };
export type NetworkItemInput = NetworkNode | NetworkSegmentInput;

export type NetworkFindingCode = "dangling-reference" | "no-equipment-path" | "missing-required-cfm" | "undersized" | "oversized";
export type NetworkFinding = {
  code: NetworkFindingCode;
  severity: "error" | "warning" | "info";
  itemId: string;
  elementRef: string;
  message: string;
};
export type NetworkSegmentSizing = {
  itemId: string;
  elementRef: string;
  cfm: number;
  role: DuctRole;
  terminalItemIds: readonly string[];
  recommended: RoundDuctSize;
  /** Present when the input segment described its existing section. */
  existing: (ExistingSection & { equivalentDiameterIn: number; comparison: RoundDuctSizeComparison }) | null;
};
export type NetworkSizingResult = {
  summary: {
    items: number;
    segments: number;
    terminals: number;
    equipment: number;
    supplyTerminalsWithCfm: number;
    sizedSegments: number;
    findings: Record<"error" | "warning" | "info", number>;
  };
  findings: readonly NetworkFinding[];
  segments: readonly NetworkSegmentSizing[];
};

const AIRFLOW_TYPES: readonly AirflowType[] = ["supply", "return", "exhaust", "outside-air", "unknown"];
const ROLES: readonly DuctRole[] = ["main", "branch", "runout"];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function fail(path: string, message: string): never {
  throw new NetworkInputError("invalid-item", path, `${path}: ${message}`);
}

function parseExisting(raw: unknown, path: string): ExistingSection {
  if (!isRecord(raw)) fail(path, "must be an object.");
  const shape = raw.shape ?? "round";
  if (shape === "round") {
    if (!isPositive(raw.diameterIn)) fail(`${path}.diameterIn`, "must be a positive number of inches.");
    return { shape, diameterIn: raw.diameterIn };
  }
  if (shape !== "rect" && shape !== "oval") fail(`${path}.shape`, "must be round, rect, or oval.");
  if (!isPositive(raw.widthIn)) fail(`${path}.widthIn`, "must be a positive number of inches.");
  if (!isPositive(raw.heightIn)) fail(`${path}.heightIn`, "must be a positive number of inches.");
  return { shape, widthIn: raw.widthIn, heightIn: raw.heightIn };
}

function parseItem(raw: unknown, path: string): NetworkItemInput {
  if (!isRecord(raw)) fail(path, "must be an object.");
  if (typeof raw.id !== "string" || raw.id.length === 0) fail(`${path}.id`, "must be a non-empty string.");
  if (typeof raw.elementRef !== "string" || raw.elementRef.length === 0) fail(`${path}.elementRef`, "must be a non-empty string.");
  const kind = raw.kind;
  if (kind !== "segment" && kind !== "equipment" && kind !== "fitting" && kind !== "terminal") fail(`${path}.kind`, "must be segment, equipment, fitting, or terminal.");
  const airflowType = raw.airflowType ?? "unknown";
  if (!(AIRFLOW_TYPES as readonly unknown[]).includes(airflowType)) fail(`${path}.airflowType`, `must be one of ${AIRFLOW_TYPES.join(", ")}.`);
  const refs = raw.connectedItemRefs ?? [];
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) fail(`${path}.connectedItemRefs`, "must be an array of elementRef strings.");
  const base = { id: raw.id, elementRef: raw.elementRef, airflowType: airflowType as AirflowType, connectedItemRefs: refs as string[] };
  if (kind === "segment") {
    const segment: NetworkSegmentInput = { ...base, kind };
    if (raw.existing !== undefined) segment.existing = parseExisting(raw.existing, `${path}.existing`);
    return segment;
  }
  const node: NetworkNode = { ...base, kind };
  if (raw.requiredCfm !== undefined && raw.requiredCfm !== null) {
    if (typeof raw.requiredCfm !== "number" || !Number.isFinite(raw.requiredCfm)) fail(`${path}.requiredCfm`, "must be a finite number of CFM.");
    node.requiredCfm = raw.requiredCfm;
  }
  return node;
}

/** Parse and validate a network document: a JSON array of items or `{ items: [...] }`. */
export function readNetworkInput(text: string): NetworkItemInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new NetworkInputError("invalid-json", null, `Input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const items = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : null;
  if (items === null) throw new NetworkInputError("invalid-item", null, "Input must be a JSON array of NetworkItems or an object with an items array.");
  return items.map((raw, index) => parseItem(raw, `items[${index}]`));
}

function equivalentDiameterIn(existing: ExistingSection): number {
  if (existing.shape === "round") return existing.diameterIn;
  return existing.shape === "rect" ? rectangularEquivalentDiameterIn(existing.widthIn, existing.heightIn) : flatOvalEquivalentDiameterIn(existing.widthIn, existing.heightIn);
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Size a validated network and grade existing sections. Host-agnostic: no scene, no editor. */
export function sizeNetworkInput(items: readonly NetworkItemInput[]): NetworkSizingResult {
  const engineItems: NetworkItem[] = items.map((item) => {
    if (item.kind !== "segment") return item;
    const { existing: _existing, ...segment } = item;
    return segment;
  });
  const result = recommendSupplyDuctSegments(engineItems);
  const findings: NetworkFinding[] = result.findings.map((finding) => ({ ...finding, severity: "error" as const }));
  for (const item of items) {
    if (item.kind === "terminal" && item.airflowType === "supply" && item.requiredCfm == null) {
      findings.push({ code: "missing-required-cfm", severity: "error", itemId: item.id, elementRef: item.elementRef, message: `Supply terminal ${item.elementRef} has no requiredCfm; it was not propagated.` });
    }
  }
  const byRef = new Map(items.map((item) => [item.elementRef, item]));
  const segments: NetworkSegmentSizing[] = result.segments.map((recommendation) => {
    const item = byRef.get(recommendation.elementRef);
    const existing = item?.kind === "segment" ? item.existing : undefined;
    let graded: NetworkSegmentSizing["existing"] = null;
    if (existing !== undefined) {
      const actual = equivalentDiameterIn(existing);
      const comparison = compareRoundDuctSize({ actualDiameterIn: actual, recommended: recommendation.size, airflowType: "supply", role: recommendation.role });
      graded = { ...existing, equivalentDiameterIn: actual, comparison };
      const standard = recommendation.size.standardDiameterIn;
      if (comparison.status === "undersized") {
        findings.push({ code: "undersized", severity: "error", itemId: recommendation.itemId, elementRef: recommendation.elementRef, message: `${recommendation.elementRef} carries ${round3(recommendation.cfm)} CFM at ${round3(actual)} in equivalent; ${standard} in round is required (${round3(comparison.actualVelocityFpm)} fpm, ${round3(comparison.actualFrictionRatePer100ft)} in. w.g./100 ft).` });
      } else if (comparison.status === "oversized") {
        findings.push({ code: "oversized", severity: "info", itemId: recommendation.itemId, elementRef: recommendation.elementRef, message: `${recommendation.elementRef} carries ${round3(recommendation.cfm)} CFM at ${round3(actual)} in equivalent; ${standard} in round would suffice.` });
      }
    }
    return { itemId: recommendation.itemId, elementRef: recommendation.elementRef, cfm: recommendation.cfm, role: recommendation.role, terminalItemIds: recommendation.terminalItemIds, recommended: recommendation.size, existing: graded };
  });
  findings.sort((a, b) => a.elementRef.localeCompare(b.elementRef) || a.code.localeCompare(b.code));
  const count = (severity: NetworkFinding["severity"]): number => findings.filter((finding) => finding.severity === severity).length;
  return {
    summary: {
      items: items.length,
      segments: items.filter((item) => item.kind === "segment").length,
      terminals: items.filter((item) => item.kind === "terminal").length,
      equipment: items.filter((item) => item.kind === "equipment").length,
      supplyTerminalsWithCfm: items.filter((item) => item.kind === "terminal" && item.airflowType === "supply" && item.requiredCfm != null).length,
      sizedSegments: segments.length,
      findings: { error: count("error"), warning: count("warning"), info: count("info") },
    },
    findings,
    segments,
  };
}

const VALUE_FLAGS = ["out", "cfm", "role", "airflow", "diameter-in"] as const;
const BOOLEAN_FLAGS = ["pretty", "fail-on-findings", "help"] as const;
type Flags = Map<string, string | true>;

function parseArgs(argv: readonly string[]): { command: string | undefined; positionals: string[]; flags: Flags } {
  const [command, ...rest] = argv;
  const flags: Flags = new Map();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--")) throw new NetworkInputError("invalid-argument", null, `--${name} needs a value.`);
      flags.set(name, next);
      index += 1;
    } else if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      flags.set(name, true);
    } else {
      throw new NetworkInputError("invalid-argument", null, `Unknown flag --${name}.`);
    }
  }
  return { command, positionals, flags };
}

function numberFlag(flags: Flags, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new NetworkInputError("invalid-argument", null, `--${name} must be a positive number, got ${String(raw)}.`);
  return value;
}

function runDuct(flags: Flags): unknown {
  const cfm = numberFlag(flags, "cfm");
  if (cfm === undefined) throw new NetworkInputError("invalid-argument", null, "duct needs --cfm.");
  const role = (flags.get("role") ?? "main") as DuctRole;
  if (!ROLES.includes(role)) throw new NetworkInputError("invalid-argument", null, `--role must be one of ${ROLES.join(", ")}.`);
  const airflowType = (flags.get("airflow") ?? "supply") as AirflowType;
  if (!AIRFLOW_TYPES.includes(airflowType) || airflowType === "unknown") throw new NetworkInputError("invalid-argument", null, "--airflow must be supply, return, exhaust, or outside-air.");
  const recommended = sizeDuctForAirflow({ cfm, role, airflowType });
  const diameterIn = numberFlag(flags, "diameter-in");
  const comparison = diameterIn === undefined ? null : compareRoundDuctSize({ actualDiameterIn: diameterIn, recommended, airflowType, role });
  return { input: { cfm, role, airflowType, diameterIn: diameterIn ?? null }, recommended, comparison };
}

type Io = { stdout: (text: string) => void; stderr: (text: string) => void };

/** Run the CLI; resolves to the process exit code. */
export async function runCli(argv: readonly string[], io: Io = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) }): Promise<number> {
  try {
    const { command, positionals, flags } = parseArgs(argv);
    if (command === undefined || command === "help" || flags.get("help") === true) {
      io.stdout(`${CLI_USAGE}\n`);
      return command === undefined ? 2 : 0;
    }
    const indent = flags.get("pretty") === true ? 2 : 0;
    const emit = async (value: unknown): Promise<void> => {
      const text = `${JSON.stringify(value, null, indent)}\n`;
      const out = flags.get("out");
      if (typeof out === "string") await writeFile(out, text, "utf8");
      else io.stdout(text);
    };
    if (command === "duct") {
      if (positionals.length > 0) throw new NetworkInputError("invalid-argument", null, `Unexpected argument ${positionals[0]}.`);
      await emit(runDuct(flags));
      return 0;
    }
    if (command !== "size") throw new NetworkInputError("invalid-argument", null, `Unknown command ${command}.\n${CLI_USAGE}`);
    if (positionals.length !== 1) throw new NetworkInputError("invalid-argument", null, "size needs exactly one network path, or - for stdin.");
    const path = positionals[0]!;
    const result = sizeNetworkInput(readNetworkInput(readFileSync(path === "-" ? 0 : path, "utf8")));
    await emit(result);
    return flags.get("fail-on-findings") === true && result.summary.findings.error > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof NetworkInputError || error instanceof DuctNetworkError || error instanceof DuctSizingError) {
      io.stderr(`${error.name} [${error.code}]: ${error.message}\n`);
      return 2;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      io.stderr(`Cannot read file: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}
