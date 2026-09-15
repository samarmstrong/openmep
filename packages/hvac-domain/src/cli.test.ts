import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NetworkInputError, readNetworkInput, runCli, sizeNetworkInput } from "./cli.js";

const examplePath = fileURLToPath(new URL("../examples/furnace-two-registers.items.json", import.meta.url));
const example = () => readNetworkInput(readFileSync(examplePath, "utf8"));

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) }, out, err };
}

describe("readNetworkInput", () => {
  it("accepts an array or an { items } document and defaults airflowType and connectedItemRefs", () => {
    const items = readNetworkInput('[{"id":"e","elementRef":"e","kind":"equipment"}]');
    expect(items).toEqual([{ id: "e", elementRef: "e", kind: "equipment", airflowType: "unknown", connectedItemRefs: [] }]);
    expect(example()).toHaveLength(9);
  });
  it("reports typed errors with a JSON path", () => {
    expect(() => readNetworkInput("{")).toThrow(NetworkInputError);
    expect(() => readNetworkInput("{}")).toThrow(/items array/);
    const bad = () => readNetworkInput('[{"id":"t","elementRef":"t","kind":"terminal","airflowType":"supply","requiredCfm":"150"}]');
    expect(bad).toThrow(NetworkInputError);
    try {
      bad();
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid-item", path: "items[0].requiredCfm" });
    }
    expect(() => readNetworkInput('[{"id":"s","elementRef":"s","kind":"segment","existing":{"shape":"rect","widthIn":10}}]')).toThrow(/items\[0\]\.existing\.heightIn/);
    expect(() => readNetworkInput('[{"id":"s","elementRef":"s","kind":"pipe"}]')).toThrow(/items\[0\]\.kind/);
  });
});

describe("sizeNetworkInput", () => {
  it("sizes the bundled furnace / tee / two-register network and grades existing 6 in runs as undersized", () => {
    const result = sizeNetworkInput(example());
    expect(result.summary).toMatchObject({ items: 9, segments: 4, terminals: 3, equipment: 1, supplyTerminalsWithCfm: 2, sizedSegments: 3, findings: { error: 3, warning: 0, info: 0 } });
    const byRef = Object.fromEntries(result.segments.map((segment) => [segment.elementRef, segment]));
    expect(byRef["duct-segment_main"]).toMatchObject({ role: "main", cfm: 250, recommended: { standardDiameterIn: 9 }, existing: { shape: "round", diameterIn: 6, comparison: { status: "undersized" } } });
    expect(byRef["duct-segment_run_a"]).toMatchObject({ role: "runout", cfm: 150, recommended: { standardDiameterIn: 8 } });
    expect(byRef["duct-segment_run_b"]).toMatchObject({ role: "runout", cfm: 100, recommended: { standardDiameterIn: 7 } });
    expect(byRef["duct-segment_return"]).toBeUndefined();
    expect(result.findings.map((finding) => `${finding.code}:${finding.elementRef}`)).toEqual(["undersized:duct-segment_main", "undersized:duct-segment_run_a", "undersized:duct-segment_run_b"]);
  });
  it("grades rect sections by circular equivalent and reports oversized as info", () => {
    const items = example().map((item) => {
      if (item.kind !== "segment") return item;
      if (item.elementRef === "duct-segment_main") return { ...item, existing: { shape: "rect" as const, widthIn: 14, heightIn: 8 } };
      return { ...item, existing: { shape: "round" as const, diameterIn: 12 } };
    });
    const result = sizeNetworkInput(items);
    const main = result.segments.find((segment) => segment.elementRef === "duct-segment_main")!;
    expect(main.existing?.equivalentDiameterIn).toBeCloseTo(11.4, 0);
    expect(main.existing?.comparison.status).toBe("oversized");
    expect(result.summary.findings).toEqual({ error: 0, warning: 0, info: 3 });
  });
  it("reports supply terminals without airflow and terminals with no path to equipment", () => {
    const items = example().map((item) => (item.elementRef === "duct-terminal_a" ? { ...item, requiredCfm: undefined } : item));
    const result = sizeNetworkInput(items);
    expect(result.findings.some((finding) => finding.code === "missing-required-cfm" && finding.elementRef === "duct-terminal_a")).toBe(true);
    // Connectivity is undirected, so break the tee ↔ run_b edge on both ends.
    const detached = example().map((item) =>
      item.elementRef === "duct-segment_run_b" || item.elementRef === "duct-fitting_tee"
        ? { ...item, connectedItemRefs: item.connectedItemRefs.filter((ref) => ref !== "duct-fitting_tee" && ref !== "duct-segment_run_b") }
        : item,
    );
    const detachedResult = sizeNetworkInput(detached);
    expect(detachedResult.findings.some((finding) => finding.code === "no-equipment-path" && finding.elementRef === "duct-terminal_b")).toBe(true);
    expect(detachedResult.segments.map((segment) => segment.elementRef)).toEqual(["duct-segment_main", "duct-segment_run_a"]);
  });
});

describe("runCli", () => {
  it("size: reads a file or stdin-like path, writes JSON, and honours --fail-on-findings", async () => {
    const { io, out } = capture();
    expect(await runCli(["size", examplePath], io)).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.summary.sizedSegments).toBe(3);
    expect(await runCli(["size", examplePath, "--fail-on-findings"], capture().io)).toBe(1);
    const outFile = join(mkdtempSync(join(tmpdir(), "openmep-hvac-")), "result.json");
    expect(await runCli(["size", examplePath, "--out", outFile, "--pretty"], capture().io)).toBe(0);
    expect(JSON.parse(readFileSync(outFile, "utf8")).segments).toHaveLength(3);
  });
  it("size: exits 2 with a typed message on bad input, missing file, or engine error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openmep-hvac-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, '[{"id":"t","elementRef":"t","kind":"terminal","airflowType":"supply","requiredCfm":-5}]');
    let captured = capture();
    expect(await runCli(["size", bad], captured.io)).toBe(2);
    expect(captured.err.join("")).toMatch(/DuctNetworkError \[invalid-terminal-airflow\]/);
    captured = capture();
    expect(await runCli(["size", join(dir, "missing.json")], captured.io)).toBe(2);
    expect(captured.err.join("")).toMatch(/Cannot read file/);
    captured = capture();
    expect(await runCli(["size"], captured.io)).toBe(2);
    expect(captured.err.join("")).toMatch(/NetworkInputError \[invalid-argument\]/);
    expect(await runCli([], capture().io)).toBe(2);
    expect(await runCli(["help"], capture().io)).toBe(0);
  });
  it("duct: sizes one run and grades an existing diameter", async () => {
    const { io, out } = capture();
    expect(await runCli(["duct", "--cfm", "250", "--role", "main", "--diameter-in", "6"], io)).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.recommended.standardDiameterIn).toBe(9);
    expect(parsed.comparison.status).toBe("undersized");
    const bad = capture();
    expect(await runCli(["duct", "--role", "main"], bad.io)).toBe(2);
    expect(bad.err.join("")).toMatch(/needs --cfm/);
    expect(await runCli(["duct", "--cfm", "100", "--airflow", "unknown"], capture().io)).toBe(2);
  });
});
