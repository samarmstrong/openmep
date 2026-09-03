import { describe, expect, it } from "vitest";
import { DuctNetworkError, recommendSupplyDuctSegments, type NetworkItem } from "./supply-network.js";
const node = (elementRef: string, kind: "equipment" | "fitting" | "terminal", connectedItemRefs: string[], requiredCfm?: number): NetworkItem => ({ id: `${elementRef}:edit`, elementRef, kind, airflowType: "supply", connectedItemRefs, requiredCfm });
const segment = (elementRef: string, connectedItemRefs: string[]): NetworkItem => ({ id: `${elementRef}:edit`, elementRef, kind: "segment", airflowType: "supply", connectedItemRefs });
describe("supply network propagation", () => {
  it("accumulates runouts through branch and main as sorted JSON arrays", () => {
    const result = recommendSupplyDuctSegments([node("EQ", "equipment", ["MAIN"]), segment("MAIN", ["EQ", "FIT"]), node("FIT", "fitting", ["MAIN", "R1", "R2"]), segment("R1", ["FIT", "T1"]), node("T1", "terminal", ["R1"], 300), segment("R2", ["FIT", "T2"]), node("T2", "terminal", ["R2"], 200)]);
    expect(result.findings).toEqual([]); expect(result.segments.map((item) => item.elementRef)).toEqual(["MAIN", "R1", "R2"]);
    expect(result.segments.find((item) => item.elementRef === "MAIN")).toMatchObject({ cfm: 500, role: "main", terminalItemIds: ["T1:edit", "T2:edit"] });
    expect(result.segments.find((item) => item.elementRef === "R1")).toMatchObject({ cfm: 300, role: "runout" });
  });
  it("chooses one lexically deterministic shortest path through a cycle", () => {
    const result = recommendSupplyDuctSegments([node("EQ", "equipment", ["A", "B"]), segment("A", ["EQ", "FIT"]), segment("B", ["EQ", "FIT"]), node("FIT", "fitting", ["A", "B", "RUN"]), segment("RUN", ["FIT", "T"]), node("T", "terminal", ["RUN"], 250)]);
    expect(result.segments.map((item) => item.elementRef)).toEqual(["A", "RUN"]);
  });
  it("normalizes one-sided connections and reports missing paths", () => {
    expect(recommendSupplyDuctSegments([node("EQ", "equipment", []), segment("RUN", ["EQ", "T"]), node("T", "terminal", [], 100)]).segments[0]?.cfm).toBe(100);
    expect(recommendSupplyDuctSegments([node("T", "terminal", [], 100)]).findings).toContainEqual(expect.objectContaining({ code: "no-equipment-path" }));
  });
  it("throws typed errors for duplicate refs and invalid terminal airflow", () => {
    expect(() => recommendSupplyDuctSegments([segment("DUP", []), node("DUP", "fitting", [])])).toThrow(DuctNetworkError);
    expect(() => recommendSupplyDuctSegments([node("T", "terminal", [], 0)])).toThrow(expect.objectContaining({ code: "invalid-terminal-airflow" }));
  });
  it("reports dangling references and ignores non-supply terminals", () => {
    const dangling = recommendSupplyDuctSegments([segment("RUN", ["MISSING"])]);
    expect(dangling.findings).toContainEqual(expect.objectContaining({ code: "dangling-reference", elementRef: "RUN" }));
    const terminal = { ...node("RETURN", "terminal", [], 100), airflowType: "return" as const };
    expect(recommendSupplyDuctSegments([terminal]).segments).toEqual([]);
  });
  it("infers a shared non-equipment segment as a branch", () => {
    const result = recommendSupplyDuctSegments([
      node("EQ", "equipment", ["MAIN"]), segment("MAIN", ["EQ", "F1"]),
      node("F1", "fitting", ["MAIN", "BRANCH"]), segment("BRANCH", ["F1", "F2"]),
      node("F2", "fitting", ["BRANCH", "R1", "R2"]),
      segment("R1", ["F2", "T1"]), node("T1", "terminal", ["R1"], 150),
      segment("R2", ["F2", "T2"]), node("T2", "terminal", ["R2"], 100),
    ]);
    expect(result.segments.find((item) => item.elementRef === "BRANCH")).toMatchObject({ cfm: 250, role: "branch" });
  });
  it("wraps sizing overflow in a typed network error", () => {
    expect(() => recommendSupplyDuctSegments([
      node("EQ", "equipment", ["RUN"]), segment("RUN", ["EQ", "T"]), node("T", "terminal", ["RUN"], 200_000),
    ])).toThrow(expect.objectContaining({ code: "duct-sizing-failed", elementRef: "RUN" }));
  });
});
