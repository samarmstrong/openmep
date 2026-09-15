# Changelog

## 0.3.0 - 2026-09-15

- `discoverPascalMcp` reads Pascal CLI 1.0.0's `run/mcp.json` and falls back to
  the 0.1.x `mcp.url` in `run/editor.json`. Live round trip re-verified against
  Pascal 1.0.0 (`pascal-mcp-server 1.0.0`).

## 0.2.0 - 2026-09-09

- `openmep-pascal mcp size|export`: live round trip through a running Pascal
  editor's MCP server (auto-discovers the local `pascal` CLI editor from
  `$PASCAL_HOME/run`; `--url`/`--token-file` or `--stdio` otherwise).
  `export_json` → size → `apply_patch` as one undo step → re-export and verify.
- Library: `discoverPascalMcp`, `connectPascalMcp`, `openPascalMcpSession`,
  `sizeThroughPascalMcp`; typed error codes `mcp-unavailable`,
  `mcp-tool-error`.
- Sizing patches are idempotent: segments already at the recommended diameter
  with a matching `metadata.openmep` record emit no patch. `summary.patches`
  added.
- `detached-node` warning for HVAC nodes not reachable from `rootNodeIds`
  (the editor prunes and autosaves them; `PascalScene.rootNodeIds` added).
- `examples/live-roundtrip.mjs` reproduces the verified run against Pascal 0.1.5,
  creating nodes under the project's default level.

## 0.1.0 - 2026-09-09

- Initial release: read a Pascal Editor scene (`export_json` / `get_scene`
  output or a saved scene file), rebuild duct connectivity from port
  coincidence, size supply runs with `@openmep/hvac-domain`, grade actual
  against recommended diameters, and emit an `apply_patch` batch plus
  findings. `openmep-pascal size|items` CLI.
