#!/usr/bin/env node
// Manual D friction-rate sizing from a worksheet: node demo.mjs [worksheet.json]
import { readFileSync } from "node:fs";
import { openmep } from "@openmep/hvac-domain/scripting";

const sheet = JSON.parse(readFileSync(process.argv[2] ?? new URL("./worksheet.json", import.meta.url), "utf8"));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// One trunk and one tee per system; every room is a run-out from that tee.
const items = [{ id: "unit", elementRef: "unit", kind: "equipment" }];
const labels = new Map();
for (const system of ["supply", "return"]) {
  const side = sheet[system];
  if (!side) continue;
  items.push(
    { id: `${system}-trunk`, elementRef: `${system}-trunk`, kind: "segment", airflowType: system, connectedItemRefs: ["unit", `${system}-tee`], lengthFt: side.trunk.lengthFt },
    { id: `${system}-tee`, elementRef: `${system}-tee`, kind: "fitting", airflowType: system, equivalentLengthFt: side.trunk.fittingEquivalentLengthFt ?? 0 },
  );
  labels.set(`${system}-trunk`, `${system} trunk`);
  for (const run of side.runs) {
    const ref = `${system}-${slug(run.room)}`;
    labels.set(ref, run.room);
    const existing = run.softwareDiameterIn ? { shape: "round", diameterIn: run.softwareDiameterIn } : undefined;
    items.push(
      { id: ref, elementRef: ref, kind: "segment", airflowType: system, connectedItemRefs: [`${system}-tee`, `${ref}-outlet`], lengthFt: run.lengthFt, existing },
      { id: `${ref}-outlet`, elementRef: `${ref}-outlet`, kind: "terminal", airflowType: system, requiredCfm: run.cfm, equivalentLengthFt: run.fittingEquivalentLengthFt ?? 0 },
    );
  }
}

const fan = { externalStaticInWg: sheet.blower.externalStaticInWg, componentLossesInWg: sheet.deviceLossesInWg ?? {} };
let result;
try {
  result = openmep.sizeNetwork({ items, fan });
} catch (e) {
  if (!openmep.isEngineError(e)) throw e;
  console.error(`${e.name} [${e.code}]: ${e.message}`);
  process.exit(2);
}

const { design, segments, findings } = result;
console.log(`Blower ESP            ${design.externalStaticInWg.toFixed(2)} in. w.g. at ${sheet.blower.designCfm ?? "?"} CFM`);
console.log(`Device losses         ${design.componentLossesInWg.toFixed(2)} in. w.g.`);
console.log(`Available static (ASP)${design.availableStaticInWg.toFixed(2).padStart(5)} in. w.g.`);
for (const p of design.paths) console.log(`Longest ${p.airflowType.padEnd(7)} run   ${String(p.effectiveLengthFt).padStart(4)} ft effective (${p.measuredLengthFt} ft + ${p.equivalentLengthFt} ft fittings) to ${labels.get(p.itemRefs[1]) ?? p.terminalItemId}`);
console.log(`Total effective length${String(design.totalEffectiveLengthFt).padStart(5)} ft`);
console.log(`Friction rate (FR)    ${design.frictionRatePer100ft.toFixed(3)} in. w.g. per 100 ft\n`);

const row = (label, cfm, size, fpm, fr, note = "") => `${label.padEnd(16)}${String(cfm).padStart(7)}${String(size).padStart(9)}${String(fpm).padStart(8)}${String(fr).padStart(8)}  ${note}`;
const order = new Map(items.map((item, i) => [item.elementRef, i]));
console.log(row("Run", "CFM", "Round in", "fpm", "FR", "vs. your size"));
for (const s of [...segments].sort((a, b) => order.get(a.elementRef) - order.get(b.elementRef))) {
  const r = s.recommended;
  const note = s.existing ? `${s.existing.comparison.status} (yours ${s.existing.diameterIn} in)` : "";
  console.log(row(labels.get(s.elementRef) ?? s.elementRef, s.cfm, r.standardDiameterIn, Math.round(r.velocityFpm), r.frictionRatePer100ft.toFixed(3), note));
}
const notable = findings.filter((f) => f.severity !== "info");
if (notable.length) console.log(`\n${notable.map((f) => `${f.severity}: ${f.message}`).join("\n")}`);
