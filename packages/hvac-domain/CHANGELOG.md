# Changelog

## 0.6.0 - 2026-10-07

- **Available-static-pressure sizing (Manual D friction rate).** A network document may carry
  `fan: { externalStaticInWg, componentLossesInWg? }`; segments may carry `lengthFt` and fittings or
  terminals `equivalentLengthFt`. The engine finds the longest effective supply and return paths
  (measured length + fitting equivalent lengths), derives FR = (ESP − Σ device losses) × 100 / TEL,
  sizes every segment at that rate (velocity caps still apply), and reports `design` (ASP, TEL,
  friction rate, the paths). Without `fan`, output is unchanged (fixed 0.08 in. w.g./100 ft).
  Verified against the ACCA Manual D friction-rate worksheet example (ESP 0.70, losses 0.50, TEL 200,
  FR 0.10): exact match on the rate; every branch within one standard size of the brochure's flex
  selections (`examples/acca-manual-d-worksheet.network.json`).
- New findings: `friction-rate-out-of-range` (warning; outside Manual D's 0.06–0.18) and
  `missing-equivalent-length` (warning; fitting counted as zero). New typed errors: `invalid-fan`,
  `missing-length`, `non-positive-available-static`.
- Library: `parseNetworkDocument`, `readNetworkDocument`, `sizeNetworkDocument`,
  `sizeNetworkInput(items, { fan })`, `recommendDuctSegments(items, { fan })`,
  `FRICTION_RATE_RANGE_PER_100FT`; `openmep.sizeNetwork(doc, { fan? })`,
  `openmep.parseNetworkDocument`, `openmep.frictionRateFromStatic`,
  `openmep.constants.frictionRateRangePer100ft`. `NetworkSizingResult` gains `design` and
  `summary.frictionRatePer100ft`.

## 0.5.0 - 2026-10-07 (not published; folded into 0.6.0)

- Scripting surface: `import { openmep } from "@openmep/hvac-domain/scripting"` (also exported from the
  root) exposes stable names over the existing engine: `sizeDuct`, `gradeDuct`, `sizeNetwork` (accepts raw
  JSON), `parseNetwork`, `applySizes`, `connectPorts`, `equivalentDiameterIn`, `velocityFpm`,
  `frictionRatePer100ft`, `maxVelocityFpm`, `constants`, `errors`, `isEngineError`, `version`.
  `docs/scripting.md` documents the API with three complete scripts. No engine math changed.
- New `openmep-engine` agent skill (repo `skills/`) teaches an agent with a shell to write and run a
  script against the namespace instead of calling one tool per duct.

## 0.4.0 - 2026-09-22

- Network sizing covers every classified system: `recommendDuctSegments(items, { airflowTypes? })`
  propagates supply, return, exhaust, and outside-air terminal CFM to equipment and sizes each
  segment with its system's velocity caps. Recommendations carry `airflowType`. An `unknown`
  segment loaded by two systems is reported as `mixed-system-segment` and not sized.
  `recommendSupplyDuctSegments` remains as the supply-only form.
- **Breaking:** types `SupplyDuctSegmentRecommendation` / `SupplyDuctNetworkResult` are now
  `DuctSegmentRecommendation` / `DuctNetworkResult`; `size` output `summary.supplyTerminalsWithCfm`
  is now `summary.terminalsWithCfm` (per system); `duct` output `comparison` is now
  `existing: { equivalentDiameterIn, comparison }`.
- `openmep-hvac size` sizes return, exhaust, and outside-air runs; `missing-required-cfm` is an
  error for supply terminals and a warning for other systems.
- `openmep-hvac duct` grades rect and oval sections (`--width-in`, `--height-in`, `--shape`).
- Library: `sizeSingleDuct`, `parseNetworkInput`, `SIZED_AIRFLOW_TYPES`.

## 0.3.1 - 2026-09-16

- `--help` as the first argument prints usage (exit 0) instead of being parsed as a command.

## 0.3.0 - 2026-09-15

- Added the `openmep-hvac` CLI: `size <network.json|->` sizes every supply run
  of a `NetworkItem` document from terminal `requiredCfm`, grades optional
  existing sections (`existing: {shape, diameterIn | widthIn, heightIn}`) as
  `ok`/`undersized`/`oversized`, and reports `missing-required-cfm`,
  `no-equipment-path`, and `dangling-reference` findings; `duct --cfm n` sizes
  one run. No host or editor required. Library exports `readNetworkInput`,
  `sizeNetworkInput`, `NetworkInputError`.
- Bundled `examples/furnace-two-registers.items.json`.

## 0.2.0 - 2026-09-09

- Added `connectCoincidentPorts`: host-agnostic connectivity from typed ports
  that coincide within a tolerance (default 5 cm), with system-tag
  compatibility, for editors that expose ports rather than explicit links.
- Added `rectangularEquivalentDiameterIn` and `flatOvalEquivalentDiameterIn`
  (ASHRAE circular equivalents for equal friction and airflow).
- Added `compareRoundDuctSize`: grades an existing diameter against a
  recommendation as `ok`, `undersized`, or `oversized`, with actual velocity,
  friction rate, and velocity-cap check.
- Removed stale generated `src/*.d.ts` files; types ship from `dist/`.

## 0.1.0 - 2026-08-03

- Initial public release: deterministic round-duct sizing and supply-network propagation.
