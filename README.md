# mep

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
| `packages/hvac-domain` (`@mep/hvac-domain`) | Dependency-free equal-friction round-duct sizing and supply-network CFM propagation. |
| `packages/agent-benchmark` (`@mep/agent-benchmark`) | Synthetic T1–T6 mechanical-plan editing benchmark (single + branching fixture sets), deterministic grader, `mep-benchmark` CLI (`grade`, `verify`, `size`), recorded results. |
| `packages/model-core` | IFC ingestion (web-ifc): storeys, spaces, elements, space boundaries, geometric envelope recovery; 2D plan extraction (Clipper2 footprints); design-day cooling/heating loads (ASHRAE 62.1 ventilation, 90.1 assemblies); mechanical plan layers with CFM-grounded terminals and inferred duct connectivity; plan validator; headless eval runner. |
| `apps/web` | Next.js 16 viewer: 3D (That Open / Three.js) and storey-driven 2D plan mode with the load dashboard. |
| `apps/worker` | `pg-boss` worker that converts IFC to Fragments and writes the model index. |

Real-model tests and evals run on **public IFC fixtures** (buildingSMART
Duplex and WBDG Office ARCH + MEP pairs, CC BY 4.0) fetched by
`fixtures/fetch-public-ifc.sh`; see `fixtures/README.md` for provenance and the
exporter quirks the pipeline handles. No IFC is committed to this repository.

## Quick start

```sh
npm install
fixtures/fetch-public-ifc.sh            # duplex + wbdg_office (~55 MB)
npm run build --workspace @mep/hvac-domain --workspace @mep/agent-benchmark
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
