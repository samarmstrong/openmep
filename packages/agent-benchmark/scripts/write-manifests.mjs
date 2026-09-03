#!/usr/bin/env node
// Regenerates fixtures/manifest.sha256 and results/manifest.sha256 from the files on disk.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const listFiles = (base, prefix = "") => readdirSync(join(base, prefix), { withFileTypes: true }).flatMap((entry) => {
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
  return entry.isDirectory() ? listFiles(base, rel) : [rel];
}).sort();
for (const dir of ["fixtures", "results"]) {
  const base = join(root, dir);
  const files = listFiles(base).filter((file) => file !== "manifest.sha256");
  writeFileSync(join(base, "manifest.sha256"), `${files.map((file) => `${sha256(readFileSync(join(base, file), "utf8"))}  ${file}`).join("\n")}\n`);
  console.log(`${dir}/manifest.sha256: ${files.length} files`);
}
