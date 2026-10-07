# Scripting the OpenMEP engine

`@openmep/hvac-domain` exposes one namespace, `openmep`, meant to be called from
a short script rather than through many separate tools. Every function is pure,
synchronous, typed, and host-free: no editor, account, or network is involved.
Airflow (CFM) is a design input that the engine never estimates.

```ts
import { openmep } from "@openmep/hvac-domain/scripting"; // or from "@openmep/hvac-domain"
```

Run scripts with Node 24+ (`node script.mjs`) or TypeScript via `npx tsx script.ts`.
Type declarations ship in `dist/scripting.d.ts`; an editor or `tsc` shows every signature.

## API

| Call | Purpose | Returns |
|---|---|---|
| `openmep.sizeDuct({ cfm, role?, airflowType?, existing? })` | Size one round duct; grade `existing` if given | `{ input, recommended, existing }` |
| `openmep.gradeDuct({ cfm, existing, role?, airflowType? })` | Same, with `existing` required | result whose `existing.comparison.status` is `ok` / `undersized` / `oversized` |
| `openmep.sizeNetwork(doc, { fan? })` | Validate and size a network document (array, `{ items, fan? }`, or typed items) | `{ design, summary, findings, segments }` |
| `openmep.parseNetwork(doc)` | Validate only | `NetworkItemInput[]` |
| `openmep.parseNetworkDocument(doc)` | Validate items and optional `fan` | `{ items, fan }` |
| `openmep.frictionRateFromStatic({ externalStaticInWg, componentLossesInWg?, totalEffectiveLengthFt })` | Manual D arithmetic alone | `{ availableStaticInWg, frictionRatePer100ft, inRange }` |
| `openmep.applySizes(items, result)` | Copy of `items` with each sized segment's `existing` set to the recommended round size | `NetworkItemInput[]` |
| `openmep.connectPorts(ports, { toleranceM? })` | Rebuild `connectedItemRefs` from port positions in one metric frame | `Map<itemRef, itemRef[]>` |
| `openmep.equivalentDiameterIn(section)` | ASHRAE circular equivalent of a round, rect, or oval section | inches |
| `openmep.velocityFpm(cfm, diameterIn)`, `openmep.frictionRatePer100ft(cfm, diameterIn)` | Air velocity and friction rate through a round duct | fpm, in. w.g./100 ft |
| `openmep.maxVelocityFpm(airflowType, role)` | Recommended velocity cap | fpm |
| `openmep.constants` | `frictionRatePer100ft` (0.08), `frictionRateRangePer100ft` (0.06–0.18), `standardRoundDiametersIn`, `airflowTypes`, `roles` | |
| `openmep.errors`, `openmep.isEngineError(e)` | Typed error classes with a stable `code`; the guard separates engine errors from bugs | |

Defaults: `role` `main`, `airflowType` `supply`. Roles: `main` touches equipment,
`runout` serves one terminal, `branch` is anything between. Systems:
`supply`, `return`, `exhaust`, `outside-air`; items marked `unknown` are
compatible with every system (typical for equipment).

### Network items

```jsonc
{ "id": "ahu", "elementRef": "ahu", "kind": "equipment" }
{ "id": "trunk", "elementRef": "trunk", "kind": "segment", "airflowType": "supply",
  "connectedItemRefs": ["ahu", "tee"], "existing": { "shape": "round", "diameterIn": 10 } }
{ "id": "tee", "elementRef": "tee", "kind": "fitting", "airflowType": "supply" }
{ "id": "run-1", "elementRef": "run-1", "kind": "segment", "airflowType": "supply", "connectedItemRefs": ["tee", "d-1"] }
{ "id": "d-1", "elementRef": "d-1", "kind": "terminal", "airflowType": "supply", "requiredCfm": 150 }
```

`connectedItemRefs` is undirected; listing a connection on one side is enough.
`existing` is optional on segments: `{ shape: "round", diameterIn }` or
`{ shape: "rect" | "oval", widthIn, heightIn }`. For fan-driven sizing, segments
carry `lengthFt` and fittings or terminals carry `equivalentLengthFt`; the document
carries `fan: { externalStaticInWg, componentLossesInWg? }`.

Finding codes from `sizeNetwork`: `missing-required-cfm` (error for supply, warning
otherwise), `no-equipment-path`, `dangling-reference`, `mixed-system-segment`
(errors), `undersized` (error), `oversized` (info), `friction-rate-out-of-range` and
`missing-equivalent-length` (warnings, fan mode only).

## Example 1: size a multi-room supply and return system

```js
import { openmep } from "@openmep/hvac-domain/scripting";

const rooms = { bed1: 120, bed2: 90, living: 200 };
const items = [
  { id: "furnace", elementRef: "furnace", kind: "equipment" },
  { id: "trunk", elementRef: "trunk", kind: "segment", airflowType: "supply", connectedItemRefs: ["furnace", "tee"] },
  { id: "tee", elementRef: "tee", kind: "fitting", airflowType: "supply" },
  ...Object.entries(rooms).flatMap(([room, cfm]) => [
    { id: `run-${room}`, elementRef: `run-${room}`, kind: "segment", airflowType: "supply", connectedItemRefs: ["tee", `reg-${room}`] },
    { id: `reg-${room}`, elementRef: `reg-${room}`, kind: "terminal", airflowType: "supply", requiredCfm: cfm },
  ]),
  { id: "ret-drop", elementRef: "ret-drop", kind: "segment", airflowType: "return", connectedItemRefs: ["furnace", "grille"] },
  { id: "grille", elementRef: "grille", kind: "terminal", airflowType: "return", requiredCfm: 410 },
];
const { summary, findings, segments } = openmep.sizeNetwork(items);
for (const s of segments) console.log(`${s.elementRef}: ${s.airflowType} ${s.role} ${s.cfm} CFM → ${s.recommended.standardDiameterIn} in`);
console.log(summary.findings, findings.map((f) => f.message));
```

## Example 2: grade an existing network and list violations

```js
import { readFileSync } from "node:fs";
import { openmep } from "@openmep/hvac-domain/scripting";

const doc = JSON.parse(readFileSync(process.argv[2], "utf8"));
const result = openmep.sizeNetwork(doc);
const violations = result.findings.filter((f) => f.severity === "error");
for (const f of violations) console.log(`${f.code}\t${f.elementRef}\t${f.message}`);
process.exitCode = violations.length > 0 ? 1 : 0;
```

## Example 3: size, patch, and prove the patch

```js
import { readFileSync, writeFileSync } from "node:fs";
import { openmep } from "@openmep/hvac-domain/scripting";

const items = openmep.parseNetwork(JSON.parse(readFileSync("network.json", "utf8")));
const before = openmep.sizeNetwork(items);
const patched = openmep.applySizes(items, before);
const after = openmep.sizeNetwork(patched);
const left = after.findings.filter((f) => f.code === "undersized");
if (left.length > 0) throw new Error(`still undersized: ${left.map((f) => f.elementRef).join(", ")}`);
writeFileSync("network.sized.json", JSON.stringify(patched, null, 2));
console.log(`resized ${before.segments.filter((s) => s.existing?.comparison.status !== "ok").length} of ${before.summary.segments} segments`);
```

Patch only what the engine sized; segments with `no-equipment-path` keep their
drawn size and should be reported, not guessed.

## Example 4: size from the blower's static pressure (Manual D)

```js
import { openmep } from "@openmep/hvac-domain/scripting";

const fan = { externalStaticInWg: 0.5, componentLossesInWg: { coil: 0.2, filter: 0.1, "supply-register": 0.03, "return-grille": 0.03 } };
const items = [
  { id: "ahu", elementRef: "ahu", kind: "equipment" },
  { id: "trunk", elementRef: "trunk", kind: "segment", airflowType: "supply", connectedItemRefs: ["ahu", "tee"], lengthFt: 20 },
  { id: "tee", elementRef: "tee", kind: "fitting", airflowType: "supply", equivalentLengthFt: 20 },
  { id: "run-a", elementRef: "run-a", kind: "segment", airflowType: "supply", connectedItemRefs: ["tee", "reg-a"], lengthFt: 35 },
  { id: "reg-a", elementRef: "reg-a", kind: "terminal", airflowType: "supply", requiredCfm: 150, equivalentLengthFt: 35 },
  { id: "ret", elementRef: "ret", kind: "segment", airflowType: "return", connectedItemRefs: ["ahu", "grille"], lengthFt: 15 },
  { id: "grille", elementRef: "grille", kind: "terminal", airflowType: "return", requiredCfm: 150, equivalentLengthFt: 10 },
];
const { design, segments, findings } = openmep.sizeNetwork({ items, fan });
console.log(`ASP ${design.availableStaticInWg} in, TEL ${design.totalEffectiveLengthFt} ft, FR ${design.frictionRatePer100ft} in/100 ft`);
for (const p of design.paths) console.log(`${p.airflowType} governing path: ${p.itemRefs.join(" → ")} = ${p.effectiveLengthFt} ft`);
for (const s of segments) console.log(`${s.elementRef}: ${s.cfm} CFM → ${s.recommended.standardDiameterIn} in (${s.recommended.governingConstraint})`);
console.log(findings.map((f) => f.message));
```

Without `fan` the engine uses the fixed default rate. Static pressure, device
losses, and lengths are design inputs: take them from the blower table, the
device data, and the drawing, never from guesses.

## Errors

```js
try { openmep.sizeNetwork(doc); }
catch (e) { if (openmep.isEngineError(e)) console.error(`${e.name} [${e.code}] ${e.message}`); else throw e; }
```

`NetworkInputError` carries `path` (for example `items[2].requiredCfm`);
`DuctNetworkError` and `DuctSizingError` carry the offending `elementRef` or value.
