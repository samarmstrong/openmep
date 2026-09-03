import { describe, expect, it } from "vitest";

import type { SpaceSummary } from "../../types";
import { classifyByName, classifySpaces } from "./classify";

const baseSpace: SpaceSummary = {
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
  properties: {}
};

describe("classifyByName heuristic", () => {
  it("matches an obvious conference room", () => {
    const result = classifyByName({ name: "Conference Room 201", longName: null });
    expect(result?.spaceTypeKey).toBe("conference-meeting");
    expect(result?.confidence).toBe("heuristic");
  });

  it("matches corridor via name token", () => {
    const result = classifyByName({ name: "Main Corridor", longName: null });
    expect(result?.spaceTypeKey).toContain("corridor");
  });

  it("returns null on unrecognisable names", () => {
    expect(classifyByName({ name: "Zone 17", longName: null })).toBeNull();
  });

  it.each([
    ["100", "LOBBY / CIRCULATION", "main-entry-lobbies"],
    ["104", "WOMEN", "toilets-public-light"],
    ["105", "MEN", "toilets-public-light"],
    ["106", "FAMILY RR", "toilets-public-light"],
    ["107", "JAN. / STR.", "janitor-trash-recycle"],
    ["108", "IDF", "idf-mdf-electronic-eqpt"],
    ["109", "MECHANICAL ROOM", "electrical-equipment-rooms"],
    ["110", "ELECTRICAL ROOM", "electrical-equipment-rooms"],
    ["111", "TENANT A BOH", "offices-commercial-general"],
    ["111C", "TENANT A COUNTER AREA", "sales"],
    ["111Q", "TENANT A QUEUING", "transportation-waiting"],
    ["101", "VESTIBULE", "main-entry-lobbies"],
    ["118", "UTILITY YARD", "occupiable-storage-for-dry-materials"]
  ])("classifies fixture space %s (%s)", (name, longName, expectedKey) => {
    const result = classifyByName({ name, longName });
    expect(result?.spaceTypeKey).toBe(expectedKey);
  });
});

describe("classifySpaces orchestrator", () => {
  it("uses heuristic when possible and falls back to LLM otherwise", async () => {
    const spaces: SpaceSummary[] = [
      { ...baseSpace, globalId: "g-conf", name: "Conference Room" },
      { ...baseSpace, globalId: "g-mystery", name: "Zone 7" }
    ];

    const llmCalls: SpaceSummary[][] = [];
    const result = await classifySpaces(spaces, {
      llmClassifier: async (unmatched) => {
        llmCalls.push(unmatched);
        return new Map(unmatched.map((s) => [s.globalId, "offices-commercial-general"]));
      }
    });

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].map((s) => s.globalId)).toEqual(["g-mystery"]);
    expect(result.get("g-conf")?.confidence).toBe("heuristic");
    expect(result.get("g-mystery")?.confidence).toBe("llm");
  });

  it("throws when a heuristic miss has no LLM fallback", async () => {
    const spaces: SpaceSummary[] = [
      { ...baseSpace, globalId: "g-mystery", name: "Zone 7" }
    ];
    await expect(classifySpaces(spaces)).rejects.toThrow(/could not resolve/);
  });
});
