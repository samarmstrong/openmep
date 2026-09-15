import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { PascalAdapterError } from "./errors.js";
import { discoverPascalMcp, openPascalMcpSession, sizeThroughPascalMcp } from "./mcp.js";
import { mcpTargetFromFlags } from "./cli.js";

const examplePath = fileURLToPath(new URL("../examples/furnace-two-registers.json", import.meta.url));
type Nodes = Record<string, Record<string, unknown>>;

/**
 * A stand-in for Pascal's MCP server with the semantics the adapter relies
 * on: `export_json` returns `{ json }`, `apply_patch` validates the batch,
 * applies updates as a shallow merge, and pushes one history entry per batch;
 * `undo`/`redo` walk that history.
 */
function fakePascal(initial: Nodes, options: { persistence?: { status: string; warning: string }; failApply?: boolean } = {}) {
  const history: Nodes[] = [];
  const future: Nodes[] = [];
  let nodes: Nodes = structuredClone(initial);
  const calls: string[] = [];
  const server = new McpServer({ name: "fake-pascal", version: "0.0.0-test" });
  const text = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload as Record<string, unknown> });
  server.registerTool("export_json", { inputSchema: { pretty: z.boolean().optional() } }, async () => {
    calls.push("export_json");
    return text({ json: JSON.stringify({ nodes, rootNodeIds: ["level_main"] }) });
  });
  server.registerTool("apply_patch", { inputSchema: { patches: z.array(z.object({ op: z.string(), id: z.string().optional(), data: z.record(z.string(), z.unknown()).optional() })) } }, async ({ patches }) => {
    calls.push("apply_patch");
    if (options.failApply) return { content: [{ type: "text" as const, text: "MCP error -32602: diameter out of range" }], isError: true };
    for (const patch of patches) if (patch.op !== "update" || !patch.id || !(patch.id in nodes)) throw new Error(`invalid patch for ${patch.id}`);
    history.push(structuredClone(nodes));
    future.length = 0;
    for (const patch of patches) nodes[patch.id!] = { ...nodes[patch.id!], ...patch.data };
    return text({ appliedOps: patches.length, deletedIds: [], createdIds: [], ...(options.persistence ? { persistence: options.persistence } : {}) });
  });
  server.registerTool("undo", { inputSchema: { steps: z.number().optional() } }, async ({ steps }) => {
    let undone = 0;
    for (let index = 0; index < (steps ?? 1); index++) {
      const previous = history.pop();
      if (!previous) break;
      future.push(nodes);
      nodes = previous;
      undone += 1;
    }
    return text({ undone });
  });
  server.registerTool("redo", { inputSchema: { steps: z.number().optional() } }, async ({ steps }) => {
    let redone = 0;
    for (let index = 0; index < (steps ?? 1); index++) {
      const next = future.pop();
      if (!next) break;
      history.push(nodes);
      nodes = next;
      redone += 1;
    }
    return text({ redone });
  });
  return {
    calls,
    get nodes() {
      return nodes;
    },
    async connect() {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      return openPascalMcpSession(clientTransport);
    },
  };
}

const exampleNodes = (): Nodes => (JSON.parse(readFileSync(examplePath, "utf8")) as { nodes: Nodes }).nodes;
const diameters = (nodes: Nodes) => Object.fromEntries(Object.values(nodes).filter((node) => node.type === "duct-segment").map((node) => [node.id as string, node.diameter as number]));

describe("sizeThroughPascalMcp", () => {
  it("exports, sizes, applies one apply_patch batch, verifies, and undoes as a single step", async () => {
    const pascal = fakePascal(exampleNodes());
    const session = await pascal.connect();
    expect(session.serverName).toBe("fake-pascal");
    const outcome = await sizeThroughPascalMcp(session);
    expect(outcome.result.summary.patchedSegments).toBe(3);
    expect(outcome.applied).toEqual({ appliedOps: 3, createdIds: [], deletedIds: [], persistence: null });
    expect(outcome.verification).toEqual({ ok: true, mismatches: [] });
    expect(pascal.calls).toEqual(["export_json", "apply_patch", "export_json"]);
    expect(diameters(pascal.nodes)).toEqual({ "duct-segment_main": 9, "duct-segment_run_a": 8, "duct-segment_run_b": 7, "duct-segment_return": 8 });
    expect((pascal.nodes["duct-terminal_a"]!.metadata as Record<string, unknown>).requiredCfm).toBe(150);
    expect(await session.undo()).toBe(1);
    expect(diameters(pascal.nodes)).toEqual({ "duct-segment_main": 6, "duct-segment_run_a": 6, "duct-segment_run_b": 6, "duct-segment_return": 8 });
    expect(await session.redo()).toBe(1);
    expect(diameters(pascal.nodes)["duct-segment_main"]).toBe(9);
    await session.close();
  });
  it("is idempotent: a second pass finds nothing to patch", async () => {
    const pascal = fakePascal(exampleNodes());
    const session = await pascal.connect();
    await sizeThroughPascalMcp(session);
    const second = await sizeThroughPascalMcp(session);
    expect(second.result.patches).toHaveLength(0);
    expect(second.applied).toBeNull();
    expect(second.result.findings.filter((finding) => finding.severity === "error")).toHaveLength(0);
    await session.close();
  });
  it("dry run only exports and sizes", async () => {
    const pascal = fakePascal(exampleNodes());
    const session = await pascal.connect();
    const outcome = await sizeThroughPascalMcp(session, { apply: false });
    expect(outcome.result.patches).toHaveLength(3);
    expect(outcome.applied).toBeNull();
    expect(pascal.calls).toEqual(["export_json"]);
    expect(diameters(pascal.nodes)["duct-segment_main"]).toBe(6);
    await session.close();
  });
  it("surfaces Pascal's in-memory-only persistence warning", async () => {
    const persistence = { status: "unbound", warning: "The change was applied to the in-memory session only" };
    const session = await fakePascal(exampleNodes(), { persistence }).connect();
    const outcome = await sizeThroughPascalMcp(session, { verify: false });
    expect(outcome.applied?.persistence).toEqual(persistence);
    expect(outcome.verification).toBeNull();
    await session.close();
  });
  it("turns a tool error into a typed PascalAdapterError", async () => {
    const session = await fakePascal(exampleNodes(), { failApply: true }).connect();
    await expect(sizeThroughPascalMcp(session)).rejects.toMatchObject({ name: "PascalAdapterError", code: "mcp-tool-error", message: expect.stringContaining("apply_patch failed") });
    await session.close();
  });
});

describe("discoverPascalMcp / mcpTargetFromFlags", () => {
  it("reads the local editor's run state and token like `pascal mcp connect`", () => {
    const home = mkdtempSync(join(tmpdir(), "pascal-home-"));
    mkdirSync(join(home, "run"));
    expect(discoverPascalMcp({ PASCAL_HOME: home })).toMatchObject({ ok: false, reason: "no-state-file" });
    // Pascal CLI 0.1.x layout: mcp.url inside editor.json.
    writeFileSync(join(home, "run", "editor.json"), JSON.stringify({ schemaVersion: 1, version: "0.1.5", mcp: { url: "http://127.0.0.1:59215/mcp" } }));
    expect(discoverPascalMcp({ PASCAL_HOME: home })).toMatchObject({ ok: false, reason: "no-token" });
    writeFileSync(join(home, "run", "mcp-token"), "secret\n");
    expect(discoverPascalMcp({ PASCAL_HOME: home })).toEqual({ ok: true, target: { kind: "http", url: "http://127.0.0.1:59215/mcp", token: "secret" }, stateFile: join(home, "run", "editor.json"), editorVersion: "0.1.5" });
    expect(mcpTargetFromFlags(new Map(), { PASCAL_HOME: home })).toEqual({ kind: "http", url: "http://127.0.0.1:59215/mcp", token: "secret" });
    // Pascal CLI 1.0.0 layout: a separate run/mcp.json wins; editor.json no longer carries mcp.url.
    writeFileSync(join(home, "run", "editor.json"), JSON.stringify({ schemaVersion: 1, version: "1.0.0", port: 62613 }));
    expect(discoverPascalMcp({ PASCAL_HOME: home })).toMatchObject({ ok: false, reason: "not-running" });
    writeFileSync(join(home, "run", "mcp.json"), JSON.stringify({ schemaVersion: 1, version: "1.0.0", url: "http://127.0.0.1:62616/mcp" }));
    expect(discoverPascalMcp({ PASCAL_HOME: home })).toEqual({ ok: true, target: { kind: "http", url: "http://127.0.0.1:62616/mcp", token: "secret" }, stateFile: join(home, "run", "mcp.json"), editorVersion: "1.0.0" });
  });
  it("builds explicit targets and rejects conflicting flags", () => {
    expect(mcpTargetFromFlags(new Map([["url", "http://h:1/mcp"], ["token", "t"]]))).toEqual({ kind: "http", url: "http://h:1/mcp", token: "t" });
    expect(mcpTargetFromFlags(new Map([["stdio", "pascal mcp connect"]]))).toEqual({ kind: "stdio", command: "pascal", args: ["mcp", "connect"] });
    expect(() => mcpTargetFromFlags(new Map([["url", "http://h:1/mcp"], ["stdio", "x"]]))).toThrow(PascalAdapterError);
    expect(() => mcpTargetFromFlags(new Map([["token", "t"]]))).toThrow(/need --url/);
    const missing = mkdtempSync(join(tmpdir(), "pascal-none-"));
    expect(() => mcpTargetFromFlags(new Map(), { PASCAL_HOME: missing })).toThrow(/Start it with/);
  });
});
