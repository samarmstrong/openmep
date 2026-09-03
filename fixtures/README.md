# Public IFC fixtures

Redistributable ARCH + MEP IFC pairs used by the real-model tests and evals.
All are IFC2x3 Revit exports (Architecture / MEP 2011, Solibri-optimized) using
the generic `IfcFlowSegment` / `IfcFlowTerminal` vocabulary and 1st-level
`IfcRelSpaceBoundary`. Nothing here is committed; the script downloads and
sha256-verifies each file.

| Project | Source | License | Arch | MEP | Notes |
|---|---|---|---|---|---|
| `duplex` | buildingSMART "Duplex Apartment Test Files" (NIBS Common BIM Files) | CC BY 4.0 | 1.6 MB, 21 spaces, 24 windows, 1 roof | 11 MB | Residential: hydronic + exhaust only, **no supply ductwork**. Default test fixture (fast). Site: Chicago. |
| `wbdg_office` | buildingSMART "Medical-Dental Test Files" (NIBS Office) | CC BY 4.0 | 3.9 MB, 99 spaces, 69 windows | 40 MB, 126 supply + 119 return diffusers | **Primary HVAC fixture.** Site: Boston (5A). |
| `dental_clinic` | buildingSMART "Medical-Dental Test Files" (NIBS Clinic) | CC BY 4.0 | 13 MB, 269 spaces, 31 curtain walls | 126 MB | Largest; not yet run through the pipeline. |

Mirrored by the [ifc-bench](https://huggingface.co/datasets/sylvainHellin/ifc-bench)
dataset (CC BY 4.0); originals in
[buildingsmart-community/Community-Sample-Test-Files](https://github.com/buildingsmart-community/Community-Sample-Test-Files).

```sh
fixtures/fetch-public-ifc.sh                 # duplex + wbdg_office (what CI and the tests use)
fixtures/fetch-public-ifc.sh dental_clinic
npm run eval:materialize -- \
  --arch fixtures/public/wbdg_office/arc.ifc \
  --mech fixtures/public/wbdg_office/mep.ifc \
  --model-id wbdg_office                     # writes eval-runs/wbdg_office/<storey>/
```

Downloads land in `fixtures/public/` (gitignored; override with `IFC_FIXTURE_DIR`).

## Exporter traits and how the pipeline handles them

- Elements are contained in `IfcSpace`, not the storey → `resolveContainingStoreyExpressId` walks to the storey.
- No `IfcSystem` / `IfcRelAssignsToGroup`; the system is `PSet_Revit_Mechanical.System Type` → property-based airflow classification; non-air systems (pipes, sprinklers, electrical) are excluded from the mechanical plan by `classifySystemDomain`.
- **No `IfcDistributionPort` / `IfcRelConnectsPorts`** → duct connectivity is inferred geometrically (`inferGeometricConnections`, 5 cm, model-wide) and every visual item carries a diagnostic saying so.
- Revit's reference level is not the physical level (rooftop ductwork filed under "Level 2", its fittings under "Roof") → mechanical items are assigned to the occupied storey whose elevation band contains them.
- Roofs never bound a space (ceilings are room-bounding), so roof loads are zero until plenum inference exists.
- Foundation and roof-level storeys carry exterior walls but no spaces.
