# OpenMEP

Open MEP building state that a language model can reason about and edit
correctly — grounded in deterministic loads and duct sizing, graded by a
deterministic checker.

The bet: the useful unit of AI-assisted HVAC design is not a Revit plugin but a
small, inspectable data model (rooms, loads, terminals, ducts, connectivity,
constraints) that deterministic engines compute over and agents edit. This repo
is that model, the engines, and the harness that measures whether an agent can
edit it without breaking it.

## What is here

| Workspace | What it does |
|---|---|
| `packages/hvac-domain` (`@openmep/hvac-domain`) | Dependency-free equal-friction round-duct sizing, supply/return/exhaust network CFM propagation, port-coincidence connectivity, ASHRAE equivalent diameters, and actual-vs-recommended size grading. `openmep-hvac size network.json` runs all of it on a JSON network with no editor. |
| `packages/mcp` (`@openmep/mcp`) | MCP server (`openmep-mcp`, stdio) exposing `size_duct` and `size_duct_network` to any agent, no editor needed. |
| `packages/pascal-adapter` (`@openmep/pascal-adapter`) | Sizes and checks HVAC in [Pascal Editor](https://github.com/pascalorg/editor) scenes, live through Pascal's MCP (`openmep-pascal mcp size`: export, size, `apply_patch` as one undo step, verify) or offline on exported JSON. |
| `skills/pascal-duct-sizing` | Agent skill (Pascal skills.sh format) that drives the adapter from an MCP-connected agent: gather CFM, set `metadata.requiredCfm`, run `openmep-pascal mcp size`, report, undo. `npx skills add samarmstrong/openmep --skill pascal-duct-sizing`. |
| `packages/agent-benchmark` (`@openmep/agent-benchmark`) | Synthetic T1–T6 mechanical-plan editing benchmark (single + branching fixture sets), deterministic grader, `mep-benchmark` CLI (`grade`, `verify`, `size`), recorded results. |
| `packages/model-core` | IFC ingestion (web-ifc): storeys, spaces, elements, space boundaries, geometric envelope recovery; 2D plan extraction (Clipper2 footprints); design-day cooling/heating loads (ASHRAE 62.1 ventilation, 90.1 assemblies); mechanical plan layers with CFM-grounded terminals and inferred duct connectivity; plan validator; headless eval runner. |
| `apps/web` | Next.js 16 viewer: 3D (That Open / Three.js) and storey-driven 2D plan mode with the load dashboard. |
| `apps/worker` | `pg-boss` worker that converts IFC to Fragments and writes the model index. |

Real-model tests and evals run on **public IFC fixtures** (buildingSMART
Duplex and WBDG Office ARCH + MEP pairs, CC BY 4.0) fetched by
`fixtures/fetch-public-ifc.sh`; see `fixtures/README.md` for provenance and the
exporter quirks the pipeline handles. No IFC is committed to this repository.

## Quick start

### Give an agent a duct-sizing tool

```sh
claude mcp add openmep -- npx -y -p @openmep/mcp openmep-mcp
```

Any MCP client works (`{"command": "npx", "args": ["-y", "-p", "@openmep/mcp", "openmep-mcp"]}`).
Describe the system in plain language, with the CFM each terminal needs, and the
agent calls the engine; see `packages/mcp/README.md`.

### Size a duct network from JSON (no editor required)

```sh
npx -p @openmep/hvac-domain openmep-hvac size packages/hvac-domain/examples/furnace-two-registers.items.json --pretty
npx -p @openmep/hvac-domain openmep-hvac duct --cfm 250 --role main --diameter-in 6
```

From a checkout: `npm ci && npm run build --workspace @openmep/hvac-domain`, then
`node packages/hvac-domain/bin/openmep-hvac.js ...`.

The network is a list of equipment, fittings, terminals with engineer-supplied
`requiredCfm`, and segments linked by `connectedItemRefs`. The result lists each
run's system, CFM, role, recommended standard round diameter, velocity and friction
rate, grades any existing section as `ok`/`undersized`/`oversized`, and reports
terminals with no airflow or no path to equipment. Any host that can produce this
document gets the same engine; `openmep-pascal items` produces it from a Pascal
scene.

### Try airflow design

Change a room's supply airflow, preview the connected duct sizes on the plan,
apply or undo the change, and export the edited plan JSON.

```sh
npm ci
npm run dev:design
# Open http://localhost:3001/design
```

Requires Node.js 24+. The first launch fetches the public Office IFC pair and
prepares Level 1; no database, `.env`, or model credentials are needed. Pass
`-- --refresh` to rebuild the example, or `-- --port 3002` to use another port.
Edits are session-local manual airflow scenarios with round-duct proposals;
export saves the applied plan JSON, not a rewritten IFC. The public example
labels its inferred connections and assumed initial demands. Existing model
viewers also link to **Airflow design** for their selected storey.

### Full viewer and IFC pipeline

```sh
npm ci
fixtures/fetch-public-ifc.sh            # duplex + wbdg_office (~55 MB)
npm run build --workspace @openmep/hvac-domain --workspace @openmep/agent-benchmark
npm test
```

Materialize an editable HVAC plan from the public office model:

```sh
npm run eval:materialize -- \
  --arch fixtures/public/wbdg_office/arc.ifc \
  --mech fixtures/public/wbdg_office/mep.ifc \
  --model-id wbdg_office
# eval-runs/wbdg_office/Level_1/{architecture,loads,mechanicalVisual2D,mechanicalEdit2D,baseline}.json
```

Run the synthetic agent benchmark: `npm run benchmark:verify`, or see
`packages/agent-benchmark/README.md` for grading your own candidates.

### Web app

1. Copy `.env.example` to `.env`; start PostgreSQL and create the database.
2. `npm run db:init`
3. `npm run dev:web` — seeds the Duplex pair as a stable dev fixture at
   `/models/00000000-0000-4000-8000-000000000001?mode=plan`
   (`MEP_SKIP_DEV_FIXTURE=1` to skip; `IFC_FIXTURE_DIR` to relocate fixtures).
4. `npm run dev:worker` in a second terminal.

## Status and limits

- Loads are design-day, steady-state (no RTS/CTS lag, latent, or schedules) and
  **not yet validated against a reference case**; envelope U-values come from
  ASHRAE 90.1 prescriptive tables, climate from 15 city anchors. Treat outputs
  as preliminary sizing inputs, not a sealed design.
- Roof loads are zero for Revit exports whose ceilings are room-bounding (all
  seen so far); plenum inference is open work.
- Duct connectivity for exports without `IfcRelConnectsPorts` is inferred
  geometrically and flagged as such on every item.

## License

MIT — see `LICENSE`. Fixture data keeps its upstream licenses (`fixtures/README.md`).
Release and provenance rules for the npm packages: `docs/public-artifact-release.md`.
