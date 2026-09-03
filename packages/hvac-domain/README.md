# @mep/hvac-domain

Deterministic, dependency-free ESM primitives for equal-friction round-duct sizing and supply-air network propagation.

```ts
import { recommendSupplyDuctSegments } from "@mep/hvac-domain";

const result = recommendSupplyDuctSegments(items);
```

`sizeRoundDuct` uses the ASHRAE friction-chart fit for galvanized round duct at
standard air. `sizeDuctForAirflow` applies role-based velocity caps for supply,
return, exhaust, or outside air; `sizeSupplyRoundDuct` is the supply convenience
wrapper. `recommendSupplyDuctSegments` returns sorted arrays suitable for JSON
serialization.

## Engineering basis

The round-duct relation is `Δp = 0.109136·Q^1.9/D^5.02`, with pressure drop in
in. w.g. per 100 ft, airflow in CFM, and diameter in inches. It assumes standard
air (0.075 lb/ft³) and galvanized round duct roughness near 0.0003 ft. See the
official [ASHRAE Duct Design chapter](https://handbook.ashrae.org/Handbooks/F17/IP/f17_ch21/f17_ch21_ip.aspx)
for the standard-air friction chart and the [2025 ASHRAE Handbook—Fundamentals overview](https://www.ashrae.org/technical-resources/ashrae-handbook/description-2025-ashrae-handbook-fundamentals)
for the current volume. Velocity caps are transparent recommendations, not
universal engineering limits.

## Scope and limitations

- Network propagation covers supply-air terminals with a positive `requiredCfm`
  only. Standalone sizing supports classified supply, return, exhaust, and
  outside-air inputs; `unknown` fails loudly when a velocity cap is requested.
- Round ducts only. Rectangular equivalents/helpers are intentionally not included.
- `connectedItemRefs` are treated as an undirected graph because port direction is not represented.
- Each terminal uses one lexically deterministic shortest compatible path to equipment. Loops are not hydraulically balanced and alternate paths do not share flow.
- The calculation excludes fitting losses, pressure summation, fan selection, diversity, static-regain design, elevation, non-standard air, code compliance, and engineering judgment.

Use the output as a transparent preliminary sizing primitive; validate final designs with a qualified mechanical engineer.

## Development

```sh
npm run build --workspace @mep/hvac-domain
npm run test --workspace @mep/hvac-domain
```

MIT licensed. See [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md).
