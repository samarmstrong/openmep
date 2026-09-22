# @openmep/hvac-domain

Deterministic, dependency-free ESM primitives for equal-friction round-duct sizing and supply, return, exhaust, and outside-air network propagation, plus a CLI that runs them on a JSON network with no editor or host. For agents, [`@openmep/mcp`](../mcp) serves the same engine as MCP tools.

## CLI

```sh
npx -p @openmep/hvac-domain openmep-hvac size network.json --pretty
npx -p @openmep/hvac-domain openmep-hvac duct --cfm 250 --role main --diameter-in 6
npx -p @openmep/hvac-domain openmep-hvac duct --cfm 900 --airflow return --width-in 14 --height-in 8
```

`size` takes a JSON array of `NetworkItem`s (or `{ "items": [...] }`): equipment,
fittings, terminals with `requiredCfm`, and segments linked by `connectedItemRefs`.
A segment may describe its existing section, `{"shape":"round","diameterIn":6}` or
`{"shape":"rect","widthIn":14,"heightIn":8}`, and is then graded `ok`,
`undersized`, or `oversized` by ASHRAE circular equivalent. Each terminal's
`airflowType` (`supply`, `return`, `exhaust`, `outside-air`) picks the system; its
CFM follows same-system or `unknown` items to equipment and is sized with that
system's velocity caps. Output: `summary`, `findings` (`missing-required-cfm`:
error for supply, warning for other systems; `no-equipment-path`,
`dangling-reference`, `mixed-system-segment`, `undersized`, `oversized`), and
`segments` with system, CFM, role, recommended standard diameter, velocity, and
friction rate. Exit codes: 0, 1 with `--fail-on-findings`
and error findings, 2 for invalid input (`NetworkInputError` with a JSON path) or an
engine error. See `examples/furnace-two-registers.items.json`; the same document is
what `openmep-pascal items` emits from a Pascal scene.

## Library

```ts
import { recommendDuctSegments } from "@openmep/hvac-domain";

const result = recommendDuctSegments(items); // or { airflowTypes: ["supply"] }
```

`sizeRoundDuct` uses the ASHRAE friction-chart fit for galvanized round duct at
standard air. `sizeDuctForAirflow` applies role-based velocity caps for supply,
return, exhaust, or outside air; `sizeSupplyRoundDuct` is the supply convenience
wrapper. `recommendDuctSegments` returns sorted arrays suitable for JSON
serialization; `recommendSupplyDuctSegments` restricts it to supply.
`sizeSingleDuct` and `sizeNetworkInput` are the CLI's two commands as functions.

## Engineering basis

The round-duct relation is `Δp = 0.109136·Q^1.9/D^5.02`, with pressure drop in
in. w.g. per 100 ft, airflow in CFM, and diameter in inches. It assumes standard
air (0.075 lb/ft³) and galvanized round duct roughness near 0.0003 ft. See the
official [ASHRAE Duct Design chapter](https://handbook.ashrae.org/Handbooks/F17/IP/f17_ch21/f17_ch21_ip.aspx)
for the standard-air friction chart and the [2025 ASHRAE Handbook—Fundamentals overview](https://www.ashrae.org/technical-resources/ashrae-handbook/description-2025-ashrae-handbook-fundamentals)
for the current volume. Velocity caps are transparent recommendations, not
universal engineering limits.

## Scope and limitations

- Network propagation covers terminals with a positive `requiredCfm` in a
  classified system. An `unknown` item is shared by every system; if two systems
  load the same unclassified segment it is reported, not sized.
- Recommendations are round. Existing rect and flat-oval sections are graded by
  ASHRAE circular equivalent; rectangular selection is not included.
- `connectedItemRefs` are treated as an undirected graph because port direction is not represented.
- Each terminal uses one lexically deterministic shortest compatible path to equipment. Loops are not hydraulically balanced and alternate paths do not share flow.
- The calculation excludes fitting losses, pressure summation, fan selection, diversity, static-regain design, elevation, non-standard air, code compliance, and engineering judgment.

Use the output as a transparent preliminary sizing primitive; validate final designs with a qualified mechanical engineer.

## Development

```sh
npm run build --workspace @openmep/hvac-domain
npm run test --workspace @openmep/hvac-domain
```

MIT licensed. See [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md).
