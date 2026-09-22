import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { DuctNetworkError, DuctSizingError, PortGraphError } from "@openmep/hvac-domain";
import { PascalAdapterError } from "./errors.js";
import { connectPascalMcp, discoverPascalMcp, sizeThroughPascalMcp, type PascalMcpSession, type PascalMcpTarget } from "./mcp.js";
import { buildPascalNetwork } from "./network.js";
import { readPascalScene } from "./scene.js";
import { sizePascalNetwork, type PascalSizingOptions } from "./size.js";

export const CLI_USAGE = [
  "usage:",
  "  openmep-pascal size  <scene.json|-> [--out file] [--patch-out file] [--items-out file]",
  "                       [--metadata-key key] [--tolerance-m metres] [--no-resize] [--pretty] [--fail-on-findings]",
  "  openmep-pascal items <scene.json|-> [--out file] [--pretty]",
  "  openmep-pascal mcp size   [connection] [--dry-run] [--no-verify] [sizing flags as for size]",
  "  openmep-pascal mcp export [connection] [--out file] [--pretty]",
  "",
  "size   sizes supply and return runs from terminal metadata.requiredCfm and prints findings plus an apply_patch batch.",
  "items  prints the scene as @openmep/hvac-domain NetworkItems for grading or other engines.",
  "mcp    talks to a running Pascal editor over its MCP server: export_json, size, apply_patch (one undo step), re-export to verify.",
  "",
  "connection: none (finds the local `pascal` editor via $PASCAL_HOME/run, default ~/.pascal),",
  "            --url http://127.0.0.1:PORT/mcp [--token t | --token-file f], or --stdio \"pascal mcp connect\".",
  "Exit codes: 0 ok, 1 error findings with --fail-on-findings or a failed verification, 2 invalid input, engine, or MCP error.",
].join("\n");

const VALUE_FLAGS = ["out", "patch-out", "items-out", "metadata-key", "tolerance-m", "url", "token", "token-file", "stdio"] as const;
const BOOLEAN_FLAGS = ["pretty", "no-resize", "fail-on-findings", "help", "dry-run", "no-verify"] as const;

type Flags = Map<string, string | true>;
type ParsedArgs = { command: string | undefined; positionals: string[]; flags: Flags };

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Flags = new Map();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = rest[index + 1];
      if ((VALUE_FLAGS as readonly string[]).includes(name)) {
        if (next === undefined || next.startsWith("--")) throw new PascalAdapterError("invalid-argument", null, `--${name} needs a value.`);
        flags.set(name, next);
        index += 1;
      } else if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
        flags.set(name, true);
      } else {
        throw new PascalAdapterError("invalid-argument", null, `Unknown flag --${name}.`);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

function readInput(path: string): unknown {
  const text = readFileSync(path === "-" ? 0 : path, "utf8");
  return readPascalScene(text);
}

function sizingOptions(flags: Flags): PascalSizingOptions {
  const options: PascalSizingOptions = {};
  const metadataKey = flags.get("metadata-key");
  if (typeof metadataKey === "string") options.metadataKey = metadataKey;
  const tolerance = flags.get("tolerance-m");
  if (typeof tolerance === "string") {
    const value = Number(tolerance);
    if (!Number.isFinite(value) || value < 0) throw new PascalAdapterError("invalid-argument", null, `--tolerance-m must be a non-negative number, got ${tolerance}.`);
    options.toleranceM = value;
  }
  if (flags.get("no-resize") === true) options.resizeRound = false;
  return options;
}

/** Resolve the MCP target from flags, falling back to the local editor's run state. */
export function mcpTargetFromFlags(flags: Flags, env: NodeJS.ProcessEnv = process.env): PascalMcpTarget {
  const stdio = flags.get("stdio");
  const url = flags.get("url");
  if (typeof stdio === "string" && typeof url === "string") throw new PascalAdapterError("invalid-argument", null, "Use either --url or --stdio, not both.");
  if (typeof stdio === "string") {
    const [command, ...args] = stdio.trim().split(/\s+/);
    if (!command) throw new PascalAdapterError("invalid-argument", null, "--stdio needs a command.");
    return { kind: "stdio", command, args };
  }
  const tokenFlag = flags.get("token");
  const tokenFile = flags.get("token-file");
  if (typeof tokenFlag === "string" && typeof tokenFile === "string") throw new PascalAdapterError("invalid-argument", null, "Use either --token or --token-file, not both.");
  const token = typeof tokenFlag === "string" ? tokenFlag : typeof tokenFile === "string" ? readFileSync(tokenFile, "utf8").trim() : undefined;
  if (typeof url === "string") return { kind: "http", url, ...(token !== undefined ? { token } : {}) };
  if (token !== undefined) throw new PascalAdapterError("invalid-argument", null, "--token/--token-file need --url.");
  const discovered = discoverPascalMcp(env);
  if (!discovered.ok) throw new PascalAdapterError("mcp-unavailable", null, discovered.message);
  return discovered.target;
}

type Io = { stdout: (text: string) => void; stderr: (text: string) => void };

async function withSession<T>(target: PascalMcpTarget, run: (session: PascalMcpSession) => Promise<T>): Promise<T> {
  const session = await connectPascalMcp(target);
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

async function runMcp(subcommand: string | undefined, flags: Flags, emit: (value: unknown, outFlag: string) => Promise<void>, io: Io, indent: number): Promise<number> {
  const target = mcpTargetFromFlags(flags);
  if (subcommand === "export") {
    const raw = await withSession(target, async (session) => (await session.exportScene()).raw);
    await emit(raw, "out");
    return 0;
  }
  if (subcommand !== "size") throw new PascalAdapterError("invalid-argument", null, `Unknown mcp subcommand ${subcommand ?? "(none)"}.\n${CLI_USAGE}`);
  const options = sizingOptions(flags);
  const outcome = await withSession(target, (session) => sizeThroughPascalMcp(session, { ...options, apply: flags.get("dry-run") !== true, verify: flags.get("no-verify") !== true }));
  const { result } = outcome;
  const patchOut = flags.get("patch-out");
  if (typeof patchOut === "string") await writeFile(patchOut, `${JSON.stringify({ patches: result.patches }, null, indent)}\n`, "utf8");
  const itemsOut = flags.get("items-out");
  if (typeof itemsOut === "string") await writeFile(itemsOut, `${JSON.stringify(result.network.items, null, indent)}\n`, "utf8");
  await emit({ target: target.kind === "http" ? { kind: "http", url: target.url } : target, summary: result.summary, findings: result.findings, segments: result.segments, patches: result.patches, applied: outcome.applied, verification: outcome.verification }, "out");
  if (outcome.applied?.persistence) io.stderr(`Pascal kept the change in memory only (${outcome.applied.persistence.status}): ${outcome.applied.persistence.warning}\n`);
  if (outcome.verification && !outcome.verification.ok) {
    io.stderr(`Verification failed for ${outcome.verification.mismatches.length} segment(s) after apply_patch.\n`);
    return 1;
  }
  return flags.get("fail-on-findings") === true && result.summary.findings.error > 0 ? 1 : 0;
}

/** Run the CLI; resolves to the process exit code. */
export async function runCli(argv: readonly string[], io: Io = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) }): Promise<number> {
  try {
    const { command, positionals, flags } = parseArgs(argv);
    if (command === undefined || command === "help" || command === "--help" || flags.get("help") === true) {
      io.stdout(`${CLI_USAGE}\n`);
      return command === undefined ? 2 : 0;
    }
    const indent = flags.get("pretty") === true ? 2 : 0;
    const emit = async (value: unknown, outFlag: string): Promise<void> => {
      const text = JSON.stringify(value, null, indent);
      const out = flags.get(outFlag);
      if (typeof out === "string") await writeFile(out, `${text}\n`, "utf8");
      else io.stdout(`${text}\n`);
    };
    if (command === "mcp") {
      if (positionals.length > 1) throw new PascalAdapterError("invalid-argument", null, `Unexpected argument ${positionals[1]}.`);
      return await runMcp(positionals[0], flags, emit, io, indent);
    }
    if (positionals.length > 1) throw new PascalAdapterError("invalid-argument", null, `Unexpected argument ${positionals[1]}.`);
    const input = positionals[0];
    if (input === undefined) throw new PascalAdapterError("invalid-argument", null, `${command} needs a scene path or - for stdin.`);
    const scene = readInput(input) as ReturnType<typeof readPascalScene>;
    const options = sizingOptions(flags);
    const network = buildPascalNetwork(scene, options);
    if (command === "items") {
      await emit(network.items, "out");
      return 0;
    }
    if (command !== "size") throw new PascalAdapterError("invalid-argument", null, `Unknown command ${command}.\n${CLI_USAGE}`);
    const result = sizePascalNetwork(scene, network, options);
    const patchOut = flags.get("patch-out");
    if (typeof patchOut === "string") await writeFile(patchOut, `${JSON.stringify({ patches: result.patches }, null, indent)}\n`, "utf8");
    const itemsOut = flags.get("items-out");
    if (typeof itemsOut === "string") await writeFile(itemsOut, `${JSON.stringify(network.items, null, indent)}\n`, "utf8");
    await emit({ summary: result.summary, findings: result.findings, segments: result.segments, patches: result.patches, items: network.items }, "out");
    return flags.get("fail-on-findings") === true && result.summary.findings.error > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof PascalAdapterError || error instanceof DuctNetworkError || error instanceof DuctSizingError || error instanceof PortGraphError) {
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
