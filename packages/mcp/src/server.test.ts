import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readNetworkInput, sizeDuctForAirflow, sizeNetworkInput } from "@openmep/hvac-domain";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION, createOpenMepServer } from "./server.js";

const exampleText = readFileSync(new URL("../../hvac-domain/examples/furnace-two-registers.items.json", import.meta.url), "utf8");

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createOpenMepServer().connect(serverTransport);
  const client = new Client({ name: "openmep-mcp-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const body = (result: CallToolResult): unknown => JSON.parse((result.content[0] as { text: string }).text);

describe("openmep MCP server", () => {
  it("advertises two read-only tools, instructions, and the package version", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["size_duct", "size_duct_network"]);
    for (const tool of tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(client.getInstructions()).toMatch(/never invent/);
    expect(client.getServerVersion()).toMatchObject({ name: "openmep", version: SERVER_VERSION });
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
  it("size_duct returns the engine's recommendation and grades a rect section", async () => {
    const client = await connect();
    const result = await call(client, "size_duct", { cfm: 250, role: "runout", airflowType: "return", existing: { shape: "rect", widthIn: 8, heightIn: 6 } });
    expect(result.isError).toBeFalsy();
    expect(body(result)).toMatchObject({
      recommended: sizeDuctForAirflow({ cfm: 250, role: "runout", airflowType: "return" }),
      existing: { comparison: { status: "undersized", maxVelocityFpm: 600 } },
    });
  });
  it("size_duct_network equals the library result for the bundled supply + return example", async () => {
    const client = await connect();
    const { items } = JSON.parse(exampleText) as { items: unknown[] };
    const result = await call(client, "size_duct_network", { items });
    expect(result.isError).toBeFalsy();
    expect(body(result)).toEqual(JSON.parse(JSON.stringify(sizeNetworkInput(readNetworkInput(exampleText)))));
  });
  it("reports engine input errors as readable tool errors", async () => {
    const client = await connect();
    const result = await call(client, "size_duct_network", {
      items: [
        { id: "t", elementRef: "t", kind: "terminal", airflowType: "supply", requiredCfm: -5 },
      ],
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/DuctNetworkError \[invalid-terminal-airflow\]/);
    const oversize = await call(client, "size_duct", { cfm: 500_000 });
    expect(oversize.isError).toBe(true);
    expect((oversize.content[0] as { text: string }).text).toMatch(/DuctSizingError \[diameter-exceeds-standard-range\]/);
  });
});
