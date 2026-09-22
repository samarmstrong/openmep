# @openmep/pascal-adapter

Deterministic duct sizing and checks for HVAC drawn in
[Pascal Editor](https://github.com/pascalorg/editor). Pascal holds the
geometry, ports, and MCP edit tools; this package supplies the airflow,
equal-friction sizing, and findings, and hands the result back as one
`apply_patch` batch (one undo step).

```bash
# with a local Pascal editor running (`npx @pascal-app/cli start`):
npx openmep-pascal mcp size
# or offline, on an exported scene:
npx openmep-pascal size scene.json --pretty
```

## What it does

1. Reads a Pascal scene: `export_json` / `get_scene` output, a saved scene
   file, or the raw JSON string. Only `duct-segment`, `duct-fitting`,
   `duct-terminal`, `hvac-equipment`, and `level` nodes matter; the rest are
   kept for parent lookup.
2. Rebuilds connectivity from **port coincidence** (5 cm, supply and return
   kept apart), re-implementing Pascal's port geometry for the four HVAC kinds
   so no editor runtime is needed.
3. Reads engineer-approved airflow per terminal (supply register, diffuser,
   or return grille) from
   `metadata.requiredCfm` (also `metadata.openmep.requiredCfm` or
   `metadata.cfm`; the key is configurable).
4. Sizes every supply and return run on a path from a terminal with CFM to a
   furnace or air handler with `@openmep/hvac-domain` (`recommendDuctSegments`,
   equal friction at 0.08 in. w.g./100 ft with role-based velocity caps per
   system).
5. Grades each run's actual size against the recommendation and emits
   **findings** plus an `apply_patch` batch that sets round
   `duct-segment.diameter` to the standard size and records CFM, velocity,
   friction rate, and status under `metadata.openmep`.

## CLI

```
openmep-pascal size  <scene.json|-> [--out file] [--patch-out file] [--items-out file]
                     [--metadata-key key] [--tolerance-m metres] [--no-resize] [--pretty] [--fail-on-findings]
openmep-pascal items <scene.json|-> [--out file] [--pretty]
openmep-pascal mcp size   [connection] [--dry-run] [--no-verify] [sizing flags as for size]
openmep-pascal mcp export [connection] [--out file] [--pretty]
```

`size` prints `{ summary, findings, segments, patches, items }`. `--patch-out`
writes `{ "patches": [...] }`, which is exactly the `apply_patch` argument.
`items` prints the scene as `NetworkItem`s so any other engine or grader can
consume it. Exit codes: 0 ran, 1 error findings with `--fail-on-findings` or a
failed post-apply verification, 2 malformed input, engine, or MCP error (typed
name and code on stderr).

### Live: `openmep-pascal mcp size`

Talks to a running Pascal editor through Pascal's own MCP server and does the
whole round trip: `export_json` → size → `apply_patch` (validated as a batch,
**one undo step** in the editor) → `export_json` again to verify every patched
segment landed. Re-running is idempotent: segments whose diameter and recorded
result already match get no patch, so nothing is added to the undo history.

Connection, in order of preference:

- nothing: finds the local editor started by `npx @pascal-app/cli start` (or
  `pascal editor`) from `$PASCAL_HOME/run/mcp.json` (Pascal CLI 1.0.0; 0.1.x
  used `mcp.url` in `run/editor.json`) and `$PASCAL_HOME/run/mcp-token`,
  default `~/.pascal`, exactly as `pascal mcp connect` does;
- `--url http://127.0.0.1:PORT/mcp --token-file ~/.pascal/run/mcp-token` (or
  `--token`) for a Streamable HTTP server elsewhere;
- `--stdio "pascal mcp connect"` or `--stdio "pascal-mcp --stdio"` to spawn a
  stdio server.

`--dry-run` exports and sizes without applying. The output adds `target`,
`applied` (`appliedOps`, and Pascal's `persistence` warning when the editor
kept the change in memory only because no scene is bound), and
`verification`. The library equivalent is `sizeThroughPascalMcp(session)`;
`connectPascalMcp` / `openPascalMcpSession` give a narrow typed session
(`exportScene`, `applyPatch`, `undo`, `redo`, `callTool`).

Verified against Pascal `0.1.5` from `@pascal-app/cli` on 2026-09-09
(`examples/live-roundtrip.mjs`, `npm run live:roundtrip`): the bundled scene
created through `apply_patch`, sized 6 → 9/8/7 in in one batch, `undo`
restored all three diameters in one step, `redo` reapplied them, and a second
pass patched nothing.

### Offline

1. `export_json` → save as `scene.json`.
2. `openmep-pascal size scene.json --patch-out patches.json`.
3. `apply_patch` with the contents of `patches.json`.

Try it on the bundled scene (a furnace, a round main, a tee, two runouts to a
ceiling diffuser at 150 CFM and a floor register at 100 CFM, and a separate
return drop):

```bash
npm run size:example --workspace @openmep/pascal-adapter
```

## Library

```ts
import { sizePascalScene } from "@openmep/pascal-adapter";

const result = sizePascalScene(sceneJson);
result.findings;   // undersized runs, terminals with no path to equipment, missing CFM, ...
result.patches;    // [{ op: "update", id, data: { diameter, metadata } }]
result.segments;   // per-run CFM, role, recommended size, actual equivalent diameter, comparison
result.network;    // NetworkItems, ports, connections
```

`readPascalScene`, `buildPascalNetwork`, and `sizePascalNetwork` expose the
stages separately. Errors are typed: `PascalAdapterError` (`invalid-json`,
`invalid-scene`, `invalid-node`, `invalid-argument`) from this package, and
`DuctNetworkError` / `DuctSizingError` / `PortGraphError` from
`@openmep/hvac-domain`.

### Findings

| code | severity | meaning |
|---|---|---|
| `undersized` | error | actual (or equivalent) diameter is below the exact required diameter |
| `no-equipment-path` | error | a terminal with CFM has no same-system path to a furnace / air handler |
| `no-equipment` | error | the scene has no furnace or air handler |
| `invalid-required-cfm` | error | CFM metadata present but not a positive number |
| `diameter-out-of-host-range` | error | recommended size is outside Pascal's 2–48 in `duct-segment.diameter` range |
| `dangling-reference` | error | internal consistency failure from the engine |
| `mixed-system-segment` | error | internal consistency failure: one run loaded by supply and return |
| `unsized-segment` | warning | a supply run (or a return run, once any grille has CFM) on no terminal-to-equipment path |
| `missing-required-cfm` | warning / info | supply terminal (warning) or return grille (info) without CFM metadata; it does not contribute |
| `oversized` | info | at least one full standard size above the recommendation |
| `shape-not-resized` | info | rect / oval run graded but left as drawn |
| `unsupported-fitting-type` | info | fitting kind this adapter does not know; treated as unconnected |

## Scope and limitations

- Supply runs always size; return runs size once their grilles have CFM
  (return air is not derived from supply). Equipment is shared by both sides.
- Only **round** runs are resized. Rect and flat-oval runs are graded by their
  ASHRAE circular equivalent and get metadata only.
- HVAC nodes must be reachable from the scene's `rootNodeIds` (normally a
  level under a building). Pascal's editor drops unreachable nodes when it
  opens a project and autosaves the pruned graph, while MCP `export_json`
  still shows them; the adapter reports such nodes as `detached-node`.
- Pascal's `apply_patch` update is a shallow merge, so the patch carries the
  full `metadata` record with existing keys preserved. Apply patches to the
  same scene state you exported.
- Level floor elevations are stacked per building as Pascal does; building
  position / rotation is not applied (it does not change coincidence within a
  building).
- Airflow comes from metadata an engineer supplies; there is no load
  calculation here. Zone loads from Pascal `zone` polygons are a later step.
- Pascal's node schemas move quickly. Port formulas here match
  `pascalorg/editor` at 2026-09-09; the tests pin the expected positions.
- The published `@pascal-app/core` and `@pascal-app/mcp` packages are
  bundler-only ESM (extensionless imports), so this package never imports
  them: the live path speaks MCP over HTTP or stdio and needs only a running
  editor.

## License

MIT. Port geometry is adapted from Pascal Editor (`pascalorg/editor`, MIT),
see `src/ports.ts`.
