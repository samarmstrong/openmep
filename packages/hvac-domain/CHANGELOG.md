# Changelog

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
