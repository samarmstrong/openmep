import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/openmep-pascal.js", import.meta.url));
const example = fileURLToPath(new URL("../examples/furnace-two-registers.json", import.meta.url));
const run = (...args: string[]) => {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe("openmep-pascal CLI (requires a built dist/)", () => {
  it("sizes the example scene and prints findings, patches, and items", () => {
    const { status, stdout } = run("size", example);
    expect(status).toBe(0);
    const output = JSON.parse(stdout) as { summary: { sizedSegments: number }; patches: unknown[]; findings: unknown[]; items: unknown[] };
    expect(output.summary.sizedSegments).toBe(3);
    expect(output.patches).toHaveLength(3);
    expect(output.items).toHaveLength(9);
  });
  it("writes the apply_patch batch and NetworkItems to files and fails on error findings when asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "openmep-pascal-"));
    const patchOut = join(dir, "patches.json");
    const itemsOut = join(dir, "items.json");
    const { status, stdout } = run("size", example, "--patch-out", patchOut, "--items-out", itemsOut, "--out", join(dir, "result.json"), "--fail-on-findings");
    expect(status).toBe(1);
    expect(stdout).toBe("");
    const patches = JSON.parse(readFileSync(patchOut, "utf8")) as { patches: Array<{ op: string; id: string }> };
    expect(patches.patches.map((patch) => patch.op)).toEqual(["update", "update", "update"]);
    expect(JSON.parse(readFileSync(itemsOut, "utf8"))).toHaveLength(9);
  });
  it("prints NetworkItems for the items command and reads stdin", () => {
    const result = spawnSync(process.execPath, [bin, "items", "-"], { encoding: "utf8", input: readFileSync(example, "utf8") });
    expect(result.status).toBe(0);
    const items = JSON.parse(result.stdout) as Array<{ kind: string }>;
    expect(items.filter((item) => item.kind === "terminal")).toHaveLength(3);
  });
  it("exits 2 with a typed message for bad input or arguments", () => {
    expect(run("size", join(tmpdir(), "does-not-exist.json")).status).toBe(2);
    const bad = run("size", example, "--tolerance-m", "nope");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/PascalAdapterError \[invalid-argument\]/);
    expect(run().status).toBe(2);
    expect(run("help").status).toBe(0);
    expect(run("--help").status).toBe(0);
  });
});
