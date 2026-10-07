# Changelog

## 0.2.0 - 2026-10-07

- `size_duct_network` accepts `fan: { externalStaticInWg, componentLossesInWg? }`, segment `lengthFt`,
  and fitting/terminal `equivalentLengthFt`, and then derives the Manual D friction rate from available
  static pressure over the total effective length; the response gains `design` and
  `summary.frictionRatePer100ft`. New findings `friction-rate-out-of-range`, `missing-equivalent-length`;
  new tool errors `invalid-fan`, `missing-length`, `non-positive-available-static`. Over
  `@openmep/hvac-domain` 0.6.0.

## 0.1.0 - 2026-09-22

- First release: stdio MCP server `openmep-mcp` with read-only tools `size_duct` and
  `size_duct_network` over `@openmep/hvac-domain` 0.4.0. Engine input errors return as tool
  errors with the offending field.
