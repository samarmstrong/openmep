import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PascalAdapterError } from "./errors.js";
import { buildPascalNetwork } from "./network.js";
import { readPascalScene, type PascalScene } from "./scene.js";
import { sizePascalNetwork, type PascalSizingOptions, type PascalSizingResult, type PascalUpdatePatch } from "./size.js";

/**
 * Where to reach a Pascal MCP server. `http` is the Streamable HTTP endpoint
 * the local `pascal` CLI runs behind a bearer token; `stdio` spawns a command
 * such as `pascal mcp connect` or `pascal-mcp --stdio`.
 */
export type PascalMcpTarget =
  | { kind: "http"; url: string; token?: string }
  | { kind: "stdio"; command: string; args: readonly string[] };

export type PascalMcpDiscovery =
  | { ok: true; target: Extract<PascalMcpTarget, { kind: "http" }>; stateFile: string; editorVersion: string | null }
  | { ok: false; reason: "no-state-file" | "not-running" | "no-token"; stateFile: string; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Find the MCP endpoint of a locally running Pascal editor the way its own
 * `pascal mcp connect` does. Pascal CLI 1.0.0 writes `$PASCAL_HOME/run/mcp.json`
 * (`url`, `version`); 0.1.x kept the URL under `mcp.url` in `run/editor.json`.
 * Both layouts read the bearer token from `run/mcp-token`. `PASCAL_HOME`
 * defaults to `~/.pascal`.
 */
export function discoverPascalMcp(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): PascalMcpDiscovery {
  const root = env.PASCAL_HOME && env.PASCAL_HOME.length > 0 ? env.PASCAL_HOME : join(home, ".pascal");
  const readJson = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  };
  const mcpFile = join(root, "run", "mcp.json");
  const editorFile = join(root, "run", "editor.json");
  const mcpState = readJson(mcpFile);
  const editorState = readJson(editorFile);
  if (mcpState === undefined && editorState === undefined) {
    return { ok: false, reason: "no-state-file", stateFile: mcpFile, message: `No Pascal run state at ${mcpFile} or ${editorFile}. Start it with \`npx @pascal-app/cli start\` or pass --url.` };
  }
  let url: string | null = null;
  let stateFile = mcpFile;
  let editorVersion: string | null = null;
  if (isRecord(mcpState) && typeof mcpState.url === "string") {
    url = mcpState.url;
    editorVersion = typeof mcpState.version === "string" ? mcpState.version : null;
  } else if (isRecord(editorState)) {
    stateFile = editorFile;
    const mcp = isRecord(editorState.mcp) ? editorState.mcp : null;
    url = mcp && typeof mcp.url === "string" ? mcp.url : null;
    editorVersion = typeof editorState.version === "string" ? editorState.version : null;
  }
  if (url === null) return { ok: false, reason: "not-running", stateFile, message: `${stateFile} has no MCP url; Pascal's MCP service is not running (\`pascal mcp status\`).` };
  let token: string;
  try {
    token = readFileSync(join(root, "run", "mcp-token"), "utf8").trim();
  } catch {
    return { ok: false, reason: "no-token", stateFile, message: `Cannot read ${join(root, "run", "mcp-token")}.` };
  }
  if (token.length === 0) return { ok: false, reason: "no-token", stateFile, message: `Pascal MCP token file is empty.` };
  return { ok: true, target: { kind: "http", url, token }, stateFile, editorVersion };
}

/** Build the SDK transport for a target. */
export function pascalMcpTransport(target: PascalMcpTarget): Transport {
  if (target.kind === "stdio") return new StdioClientTransport({ command: target.command, args: [...target.args], stderr: "pipe" });
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw new PascalAdapterError("invalid-argument", null, `Invalid MCP URL ${target.url}.`);
  }
  const headers: Record<string, string> = target.token ? { authorization: `Bearer ${target.token}` } : {};
  return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

export type PascalApplyPatchResult = {
  appliedOps: number;
  createdIds: readonly string[];
  deletedIds: readonly string[];
  /** Present when Pascal kept the change in memory only (no bound scene). */
  persistence: { status: string; warning: string } | null;
};

/** A connected Pascal MCP client narrowed to the tools the adapter uses. */
export type PascalMcpSession = {
  readonly serverName: string | null;
  readonly serverVersion: string | null;
  exportScene(): Promise<PascalScene & { raw: unknown }>;
  applyPatch(patches: readonly PascalUpdatePatch[] | readonly Record<string, unknown>[]): Promise<PascalApplyPatchResult>;
  undo(steps?: number): Promise<number>;
  redo(steps?: number): Promise<number>;
  /** Raw tool call for tools the adapter does not wrap (`create_project`, `save_scene`, ...). */
  callTool(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

/** Open a session over any SDK transport; tests pass an in-memory pair. */
export async function openPascalMcpSession(transport: Transport, clientInfo = { name: "openmep-pascal", version: "0.3.1" }): Promise<PascalMcpSession> {
  const client = new Client(clientInfo);
  try {
    await client.connect(transport);
  } catch (error) {
    throw new PascalAdapterError("mcp-unavailable", null, `Cannot connect to Pascal MCP: ${error instanceof Error ? error.message : String(error)}`);
  }
  const server = client.getServerVersion();

  const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const result = await client.callTool({ name, arguments: args });
    const text = Array.isArray(result.content) ? result.content.find((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")?.text : undefined;
    if (result.isError) throw new PascalAdapterError("mcp-tool-error", null, `Pascal MCP ${name} failed: ${text ?? "no error text"}`);
    if (isRecord(result.structuredContent)) return result.structuredContent;
    if (text === undefined) throw new PascalAdapterError("mcp-tool-error", null, `Pascal MCP ${name} returned no content.`);
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error("not an object");
      return parsed;
    } catch {
      throw new PascalAdapterError("mcp-tool-error", null, `Pascal MCP ${name} returned non-JSON content.`);
    }
  };

  const count = (payload: Record<string, unknown>, key: string): number => (typeof payload[key] === "number" ? (payload[key] as number) : 0);

  return {
    serverName: server?.name ?? null,
    serverVersion: server?.version ?? null,
    callTool,
    async exportScene() {
      const payload = await callTool("export_json", { pretty: false });
      if (typeof payload.json !== "string") throw new PascalAdapterError("mcp-tool-error", null, "Pascal MCP export_json returned no json string.");
      const raw: unknown = JSON.parse(payload.json);
      return { ...readPascalScene(raw), raw };
    },
    async applyPatch(patches) {
      const payload = await callTool("apply_patch", { patches: [...patches] });
      const ids = (key: string): string[] => (Array.isArray(payload[key]) ? (payload[key] as unknown[]).filter((id): id is string => typeof id === "string") : []);
      const persistence = isRecord(payload.persistence) && typeof payload.persistence.status === "string" ? { status: payload.persistence.status, warning: typeof payload.persistence.warning === "string" ? payload.persistence.warning : "" } : null;
      return { appliedOps: count(payload, "appliedOps"), createdIds: ids("createdIds"), deletedIds: ids("deletedIds"), persistence };
    },
    async undo(steps = 1) {
      return count(await callTool("undo", { steps }), "undone");
    },
    async redo(steps = 1) {
      return count(await callTool("redo", { steps }), "redone");
    },
    async close() {
      await client.close();
    },
  };
}

/** Connect to a target (see `discoverPascalMcp` for the default local editor). */
export async function connectPascalMcp(target: PascalMcpTarget): Promise<PascalMcpSession> {
  return openPascalMcpSession(pascalMcpTransport(target));
}

export type PascalMcpSizeOptions = PascalSizingOptions & {
  /** Send the `apply_patch` batch (default true). `false` only exports and sizes. */
  apply?: boolean;
  /** Re-export after applying and check every patched segment landed (default true). */
  verify?: boolean;
};

export type PascalMcpVerification = {
  ok: boolean;
  /** Segments whose diameter or `metadata.<key>` differ from the patch after re-export. */
  mismatches: readonly { nodeId: string; expectedDiameterIn: number | null; actualDiameterIn: number | null; metadataPresent: boolean }[];
};

export type PascalMcpSizeOutcome = {
  result: PascalSizingResult;
  /** `null` when nothing was sent: dry run or no patches. */
  applied: PascalApplyPatchResult | null;
  verification: PascalMcpVerification | null;
};

/**
 * One round trip over a live session: `export_json` → size → `apply_patch`
 * (one undo step on Pascal's side) → re-export and verify. Pure sizing
 * results are identical to `sizePascalScene` on the exported JSON.
 */
export async function sizeThroughPascalMcp(session: PascalMcpSession, options: PascalMcpSizeOptions = {}): Promise<PascalMcpSizeOutcome> {
  const { apply = true, verify = true, ...sizing } = options;
  const scene = await session.exportScene();
  const network = buildPascalNetwork(scene, sizing);
  const result = sizePascalNetwork(scene, network, sizing);
  if (!apply || result.patches.length === 0) return { result, applied: null, verification: null };
  const applied = await session.applyPatch(result.patches);
  if (!verify) return { result, applied, verification: null };
  const after = await session.exportScene();
  const metadataKey = sizing.metadataKey ?? "openmep";
  const mismatches: { nodeId: string; expectedDiameterIn: number | null; actualDiameterIn: number | null; metadataPresent: boolean }[] = [];
  for (const patch of result.patches) {
    const node = after.hvacNodes.get(patch.id);
    const actualDiameterIn = node?.type === "duct-segment" ? node.diameter : null;
    const expectedDiameterIn = patch.data.diameter ?? actualDiameterIn;
    const metadataPresent = node !== undefined && isRecord(node.metadata[metadataKey]);
    if (actualDiameterIn !== expectedDiameterIn || !metadataPresent) mismatches.push({ nodeId: patch.id, expectedDiameterIn, actualDiameterIn, metadataPresent });
  }
  return { result, applied, verification: { ok: mismatches.length === 0, mismatches } };
}
