import { spawn } from "node:child_process";
import { z } from "zod";

import type { SpaceSummary } from "../../types";
import { SPACE_TYPES } from "./space-types";

const DEFAULT_CLAUDE_BIN = "claude";
const DEFAULT_MODEL = "claude-opus-5";

const responseSchema = z.object({
  classifications: z.array(
    z.object({
      globalId: z.string(),
      spaceTypeKey: z.string()
    })
  )
});

export type ClaudeCodeClassifierOptions = {
  /** Override the `claude` binary path. Defaults to looking it up on PATH. */
  binPath?: string;
  /** Model string accepted by `claude -p --model` */
  model?: string;
  /** Raw subprocess invoker — exposed so tests can stub it out. */
  invoke?: (args: string[], stdin: string) => Promise<string>;
  /**
   * Pass `--bare` to skip auto-discovery of hooks, skills, plugins, MCP servers,
   * and CLAUDE.md. Faster, more deterministic, and isolates the call from the
   * developer's personal Claude Code config. Requires `ANTHROPIC_API_KEY` (or
   * a settings file with an `apiKeyHelper`) — OAuth tokens are not read in bare
   * mode. Default: true.
   */
  bare?: boolean;
};

export function createClaudeCodeClassifier(
  options: ClaudeCodeClassifierOptions = {}
): (spaces: SpaceSummary[]) => Promise<Map<string, string>> {
  const model = options.model ?? DEFAULT_MODEL;
  const binPath = options.binPath ?? DEFAULT_CLAUDE_BIN;
  const invoke = options.invoke ?? defaultInvoke(binPath);
  const bare = options.bare ?? true;

  if (bare && !process.env.ANTHROPIC_API_KEY && options.invoke === undefined) {
    // Fail loud per CLAUDE.md — do not silently attempt and hit an opaque auth error.
    throw new Error(
      "ANTHROPIC_API_KEY is required when using claude -p in --bare mode. " +
        "Set ANTHROPIC_API_KEY or pass bare:false."
    );
  }

  return async (spaces: SpaceSummary[]) => {
    if (spaces.length === 0) {
      return new Map();
    }

    const prompt = buildPrompt(spaces);
    const schema = JSON.stringify(jsonSchema);
    const args = [
      ...(bare ? ["--bare"] : []),
      "-p",
      prompt,
      "--model",
      model,
      "--output-format",
      "json",
      "--json-schema",
      schema
    ];

    const rawOutput = await invoke(args, "");
    let envelope: unknown;
    try {
      envelope = JSON.parse(rawOutput);
    } catch (error) {
      throw new Error(
        `claude -p returned non-JSON output: ${rawOutput.slice(0, 400)}`
      );
    }

    assertNoEnvelopeError(envelope);
    const structured = extractStructuredOutput(envelope);
    const parsed = responseSchema.parse(structured);

    const byId = new Map<string, string>();
    for (const entry of parsed.classifications) {
      byId.set(entry.globalId, entry.spaceTypeKey);
    }

    for (const space of spaces) {
      if (!byId.has(space.globalId)) {
        throw new Error(
          `claude classifier omitted space ${space.globalId} (${space.name}).`
        );
      }
    }
    return byId;
  };
}

function buildPrompt(spaces: SpaceSummary[]): string {
  const catalog = SPACE_TYPES.map(
    (entry) => `- ${entry.key}: ${entry.displayName}`
  ).join("\n");
  const rows = spaces
    .map((space) => {
      const name = space.name?.trim() || "(unnamed)";
      const longName = space.longName?.trim();
      return longName
        ? `- ${space.globalId} | name: ${name} | longName: ${longName}`
        : `- ${space.globalId} | name: ${name}`;
    })
    .join("\n");

  return [
    "You classify architectural spaces into ASHRAE 62.1 ventilation categories.",
    "For each space below, pick exactly one key from the catalog that best matches the space's name. If the name is ambiguous, choose the closest commercial-building default.",
    "Return one classification per input space — do not drop any, do not invent keys that are not in the catalog.",
    "",
    "CATALOG (key: displayName):",
    catalog,
    "",
    "SPACES (IFC globalId | name | longName):",
    rows
  ].join("\n");
}

const jsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    classifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          globalId: { type: "string" },
          spaceTypeKey: { type: "string" }
        },
        required: ["globalId", "spaceTypeKey"]
      }
    }
  },
  required: ["classifications"]
} as const;

function assertNoEnvelopeError(envelope: unknown): void {
  if (!envelope || typeof envelope !== "object") {
    return;
  }
  const obj = envelope as Record<string, unknown>;
  if (obj.is_error === true) {
    const message =
      typeof obj.result === "string" ? obj.result : JSON.stringify(obj).slice(0, 400);
    throw new Error(`claude -p reported an error: ${message}`);
  }
}

function extractStructuredOutput(envelope: unknown): unknown {
  if (envelope && typeof envelope === "object" && "structured_output" in envelope) {
    return (envelope as { structured_output: unknown }).structured_output;
  }
  if (envelope && typeof envelope === "object" && "result" in envelope) {
    const result = (envelope as { result: unknown }).result;
    if (typeof result === "string") {
      try {
        return JSON.parse(result);
      } catch {
        throw new Error(
          `claude -p 'result' field was not JSON: ${result.slice(0, 400)}`
        );
      }
    }
  }
  return envelope;
}

function defaultInvoke(binPath: string) {
  return (args: string[], stdin: string) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(binPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8");
          reject(
            new Error(
              `claude -p exited with code ${code}: ${stderr.slice(0, 2000)}`
            )
          );
          return;
        }
        resolve(Buffer.concat(stdoutChunks).toString("utf8"));
      });
      if (stdin) {
        child.stdin.write(stdin);
      }
      child.stdin.end();
    });
}
