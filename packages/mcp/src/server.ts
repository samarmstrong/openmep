import {
  DEFAULT_FRICTION_RATE_PER_100FT,
  DuctNetworkError,
  DuctSizingError,
  NetworkInputError,
  parseNetworkInput,
  sizeNetworkInput,
  sizeSingleDuct,
} from "@openmep/hvac-domain";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const SERVER_NAME = "openmep";
/** Kept equal to package.json `version` (checked by a test). */
export const SERVER_VERSION = "0.1.0";

export const SERVER_INSTRUCTIONS = [
  "OpenMEP sizes HVAC ducts deterministically: equal friction at a",
  `${DEFAULT_FRICTION_RATE_PER_100FT} in. w.g./100 ft target with role-based velocity caps per system,`,
  "rounded up to standard round diameters. Existing rect and oval sections are graded by",
  "ASHRAE circular equivalent. Use size_duct for one run and size_duct_network for a connected",
  "system (terminals, segments, fittings, equipment). Airflow (CFM) is a design input: never",
  "invent it; ask the user. Results are recommendations for an engineer to review.",
].join(" ");

const systemSchema = z.enum(["supply", "return", "exhaust", "outside-air"]);
const roleSchema = z.enum(["main", "branch", "runout"]);
const positiveInches = z.number().positive();
const existingSchema = z
  .union([
    z.object({ shape: z.literal("round").default("round"), diameterIn: positiveInches }),
    z.object({ shape: z.enum(["rect", "oval"]), widthIn: positiveInches, heightIn: positiveInches }),
  ])
  .describe("Existing section to grade: { diameterIn } for round, or { shape: rect|oval, widthIn, heightIn }.");

const networkItemSchema = z.object({
  id: z.string().min(1).describe("Caller's id for this item; echoed in results."),
  elementRef: z.string().min(1).describe("Unique reference other items use in connectedItemRefs."),
  kind: z.enum(["segment", "fitting", "terminal", "equipment"]),
  airflowType: z
    .enum(["supply", "return", "exhaust", "outside-air", "unknown"])
    .optional()
    .describe("System. Default unknown, which is compatible with every system (typical for equipment)."),
  connectedItemRefs: z.array(z.string()).optional().describe("elementRefs this item touches; one side of each connection is enough."),
  requiredCfm: z.number().nullable().optional().describe("Terminals only: design airflow in CFM."),
  existing: existingSchema.optional().describe("Segments only: the drawn section, graded against the recommendation."),
});

function text(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Engine input errors become tool errors the model can read and correct; anything else is a bug and propagates. */
function toolError(error: unknown): CallToolResult {
  if (error instanceof NetworkInputError || error instanceof DuctNetworkError || error instanceof DuctSizingError) {
    return { isError: true, content: [{ type: "text", text: `${error.name} [${error.code}]: ${error.message}` }] };
  }
  throw error;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** An MCP server exposing the OpenMEP sizing engine. Connect it to any transport. */
export function createOpenMepServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  server.registerTool(
    "size_duct",
    {
      title: "Size one duct",
      description:
        "Recommend a standard round diameter for one duct run carrying a given CFM, with velocity and friction at that size. " +
        "Optionally grade an existing round, rect, or oval section as ok, undersized, or oversized.",
      inputSchema: {
        cfm: z.number().positive().describe("Airflow the run carries, CFM."),
        role: roleSchema.optional().describe("main (at equipment), branch (serves several terminals), or runout (one terminal). Default main."),
        airflowType: systemSchema.optional().describe("System, which sets the velocity cap. Default supply."),
        existing: existingSchema.optional(),
      },
      annotations: { title: "Size one duct", ...readOnly },
    },
    async ({ cfm, role, airflowType, existing }) => {
      try {
        return text(sizeSingleDuct({ cfm, role, airflowType, existing }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "size_duct_network",
    {
      title: "Size a duct network",
      description:
        "Size every supply, return, exhaust, and outside-air segment of a connected duct network. Each terminal's requiredCfm " +
        "is carried along its shortest same-system path to equipment and summed per segment; roles (main/branch/runout) are " +
        "inferred. Returns per-segment recommendations, grades for segments with an existing section, and findings: " +
        "missing-required-cfm, no-equipment-path, dangling-reference, mixed-system-segment, undersized, oversized.",
      inputSchema: { items: z.array(networkItemSchema).describe("Every terminal, segment, fitting, and equipment item in the network.") },
      annotations: { title: "Size a duct network", ...readOnly },
    },
    async ({ items }) => {
      try {
        return text(sizeNetworkInput(parseNetworkInput({ items })));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  return server;
}

/** Serve over stdio until the client disconnects. */
export async function runStdioServer(): Promise<void> {
  await createOpenMepServer().connect(new StdioServerTransport());
}
