import { describe, expect, it } from "vitest";

import type { SpaceSummary } from "../../types";
import { createClaudeCodeClassifier } from "./classify-claude-code";

function space(overrides: Partial<SpaceSummary>): SpaceSummary {
  return {
    modelId: "m1",
    sourceId: "architecture",
    discipline: "architecture",
    expressId: 1,
    sourceGlobalId: "g1",
    globalId: "g1",
    compositeGlobalId: "g1",
    name: "",
    longName: null,
    storeyGlobalId: "s1",
    area: 100,
    placement: null,
    bounds: null,
    properties: {},
    ...overrides
  };
}

describe("createClaudeCodeClassifier", () => {
  it("returns an empty map for an empty input without shelling out", async () => {
    const classifier = createClaudeCodeClassifier({
      invoke: async () => {
        throw new Error("should not be invoked");
      }
    });
    const result = await classifier([]);
    expect(result.size).toBe(0);
  });

  it("parses structured_output envelopes from claude -p", async () => {
    const capturedArgs: string[][] = [];
    const classifier = createClaudeCodeClassifier({
      invoke: async (args) => {
        capturedArgs.push(args);
        return JSON.stringify({
          structured_output: {
            classifications: [
              { globalId: "g-mystery-1", spaceTypeKey: "offices-commercial-general" },
              { globalId: "g-mystery-2", spaceTypeKey: "corridors" }
            ]
          }
        });
      }
    });
    const result = await classifier([
      space({ globalId: "g-mystery-1", name: "Zone 7" }),
      space({ globalId: "g-mystery-2", name: "Hall" })
    ]);
    expect(result.get("g-mystery-1")).toBe("offices-commercial-general");
    expect(result.get("g-mystery-2")).toBe("corridors");
    const [args] = capturedArgs;
    expect(args).toContain("--bare");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--json-schema");
  });

  it("parses legacy envelopes where structured output is a JSON string in result", async () => {
    const classifier = createClaudeCodeClassifier({
      invoke: async () =>
        JSON.stringify({
          result: JSON.stringify({
            classifications: [
              { globalId: "g-1", spaceTypeKey: "offices-commercial-general" }
            ]
          })
        })
    });
    const result = await classifier([space({ globalId: "g-1", name: "Zone" })]);
    expect(result.get("g-1")).toBe("offices-commercial-general");
  });

  it("fails loud if the classifier omits any requested space", async () => {
    const classifier = createClaudeCodeClassifier({
      invoke: async () =>
        JSON.stringify({
          structured_output: {
            classifications: [
              { globalId: "g-1", spaceTypeKey: "offices-commercial-general" }
            ]
          }
        })
    });
    await expect(
      classifier([
        space({ globalId: "g-1", name: "Office" }),
        space({ globalId: "g-2", name: "Lounge" })
      ])
    ).rejects.toThrow(/omitted space g-2/);
  });

  it("surfaces error envelopes (is_error=true) as exceptions", async () => {
    const classifier = createClaudeCodeClassifier({
      invoke: async () =>
        JSON.stringify({
          is_error: true,
          result: "Not logged in · Please run /login"
        })
    });
    await expect(
      classifier([space({ globalId: "g-1", name: "Office" })])
    ).rejects.toThrow(/Not logged in/);
  });

  it("surfaces non-JSON subprocess output", async () => {
    const classifier = createClaudeCodeClassifier({
      invoke: async () => "not json at all"
    });
    await expect(
      classifier([space({ globalId: "g-1", name: "Office" })])
    ).rejects.toThrow(/returned non-JSON/);
  });
});
