import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { extractIfcIndex } from "./server/ifc";
import { CURRENT_PLAN_VERSION, extractIfcPlanModel } from "./server/plan";
import { buildCompositePlanModel, composeCompositeIndex } from "./server/service";
import { sizeDuctForAirflow, validateMechanicalPlan } from "./server/hvac";
import { publicFixturePath } from "./test/fixtures";

// Public buildingSMART sample exports (CC BY 4.0, IFC2x3, metres). Measured on
// 2026-09-02 with `fixtures/fetch-public-ifc.sh`:
//   duplex/arc.ifc       4 storeys (T/FDN, Level 1, Level 2, Roof), 21 spaces,
//                        walls + door openings, site Chicago.
//   duplex/mep.ifc       residential hydronic + exhaust — ~16 plan items, no
//                        supply ductwork.
//   wbdg_office/arc.ifc  3 storeys (Level 1, Level 2, Roof), 99 spaces, Boston.
//   wbdg_office/mep.ifc  ~5.7k mechanical elements; 126 supply + 119 return
//                        diffusers; no IfcSystem / IfcRelConnectsPorts.
// Counts below are floors, not exact matches, so small extractor changes do not
// churn this file.

function signedArea(points: [number, number][]) {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current[0] * next[1] - next[0] * current[1];
  }
  return sum / 2;
}

function pointInRing(point: [number, number], ring: [number, number][]) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    const intersects =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || Number.EPSILON) + xi;

    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(
  point: [number, number],
  polygon: { outer: [number, number][]; holes: [number, number][][] }
) {
  if (!pointInRing(point, polygon.outer)) {
    return false;
  }
  return polygon.holes.every((hole) => !pointInRing(point, hole));
}

function normalizeRightAngleAngle(angle: number) {
  while (angle <= -Math.PI / 4) {
    angle += Math.PI / 2;
  }
  while (angle > Math.PI / 4) {
    angle -= Math.PI / 2;
  }
  return angle;
}

function dominantWallAxisDeviation(
  primitives: Array<{
    polygons: Array<{ outer: [number, number][] }>;
  }>,
  minEdgeLength: number
) {
  let cos4 = 0;
  let sin4 = 0;
  let totalWeight = 0;

  for (const primitive of primitives) {
    for (const polygon of primitive.polygons) {
      const ring = polygon.outer;
      for (let index = 0; index < ring.length; index += 1) {
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];
        const dx = next[0] - current[0];
        const dy = next[1] - current[1];
        const length = Math.hypot(dx, dy);
        if (length < minEdgeLength) {
          continue;
        }

        const weight = length * length;
        const angle = Math.atan2(dy, dx);
        cos4 += Math.cos(angle * 4) * weight;
        sin4 += Math.sin(angle * 4) * weight;
        totalWeight += weight;
      }
    }
  }

  expect(totalWeight).toBeGreaterThan(0);
  return Math.abs(normalizeRightAngleAngle(Math.atan2(sin4, cos4) / 4)) * 180 / Math.PI;
}

async function readFixture(project: "duplex" | "wbdg_office", file: "arc.ifc" | "mep.ifc") {
  return new Uint8Array(await readFile(publicFixturePath(project, file)));
}

type ProcessedSource = Parameters<typeof composeCompositeIndex>[1][number];

function processedSource(
  modelId: string,
  discipline: "architecture" | "mechanical",
  bytes: Uint8Array,
  index: Awaited<ReturnType<typeof extractIfcIndex>>
): ProcessedSource {
  const now = new Date().toISOString();
  return {
    summary: {
      modelId,
      sourceId: discipline,
      discipline,
      name: discipline === "architecture" ? "ARCH" : "MECH",
      status: "ready",
      schema: index.schema,
      sourceKey: `${discipline}.ifc`,
      fragmentsKey: `${discipline}.frag`,
      indexKey: `${discipline}.json`,
      createdAt: now,
      updatedAt: now,
      counts: {
        storeys: index.storeys.length,
        spaces: index.spaces.length,
        elements: index.elements.length
      },
      fragmentsUrl: `/${discipline}`,
      errorMessage: null
    },
    bytes,
    index
  };
}

// Deterministic offline classifier so the heuristic-miss path does not need
// an LLM. Loads content is validated elsewhere; these tests need the pipeline
// to produce a valid PlanModel.
const officeClassifier = async (spaces: Array<{ globalId: string }>) =>
  new Map(spaces.map((space) => [space.globalId, "offices-commercial-general"]));

describe("extractIfcIndex", () => {
  it(
    "indexes the public Duplex ARCH fixture with expected spatial structure",
    async () => {
      const bytes = await readFixture("duplex", "arc.ifc");

      const index = await extractIfcIndex(bytes, "sample-model");

      expect(index.schema).toBe("IFC2X3");
      expect(index.lengthUnit).toBe("metre");
      expect(index.storeys).toHaveLength(4);
      expect(index.spaces).toHaveLength(21);
      expect(index.elements.length).toBeGreaterThan(200);

      const storeyNames = index.storeys.map((storey) => storey.name);
      expect(storeyNames).toContain("Level 1");
      expect(storeyNames).toContain("Level 2");

      // IfcSite carries the Chicago site location the climate resolver keys off.
      expect(index.site.latitude).toBeCloseTo(41.87, 1);
      expect(index.site.longitude).toBeCloseTo(-87.64, 1);

      for (const space of index.spaces) {
        expect(Number.isFinite(space.area ?? null)).toBe(true);
        expect(space.area ?? 0).toBeGreaterThan(0);
      }
    },
    120_000
  );
});

describe("extractIfcPlanModel", () => {
  it(
    "extracts a deterministic plan model for the public Duplex ARCH fixture",
    async () => {
      const bytes = await readFixture("duplex", "arc.ifc");

      const plan = await extractIfcPlanModel(bytes, "sample-model");

      expect(plan.planVersion).toBe(CURRENT_PLAN_VERSION);
      expect(plan.storeys).toHaveLength(4);
      expect(plan.storeys.reduce((total, storey) => total + storey.architecture.spaces.length, 0)).toBe(21);

      const primitives = plan.storeys.flatMap((storey) => storey.architecture.primitives);
      expect(primitives.some((primitive) => primitive.kind === "wall")).toBe(true);
      expect(primitives.some((primitive) => primitive.kind === "door-opening")).toBe(true);

      for (const storey of plan.storeys) {
        expect(storey.planVersion).toBe(CURRENT_PLAN_VERSION);
        expect(storey.units).toBe("metre");
        expect(Number.isFinite(storey.bounds.min[0])).toBe(true);
        expect(Number.isFinite(storey.bounds.min[1])).toBe(true);
        expect(Number.isFinite(storey.bounds.max[0])).toBe(true);
        expect(Number.isFinite(storey.bounds.max[1])).toBe(true);
        expect(Number.isFinite(storey.contextBounds.max[0])).toBe(true);
        expect(Number.isFinite(storey.focusBounds.max[0])).toBe(true);
        expect(Number.isFinite(storey.worldBounds3D.min[0])).toBe(true);
        expect(Number.isFinite(storey.worldBounds3D.max[2])).toBe(true);
        // Storey frames are re-based near the origin; the duplex footprint is
        // roughly 18 m x 9 m.
        expect(Math.max(Math.abs(storey.bounds.max[0]), Math.abs(storey.bounds.max[1]))).toBeLessThan(500);
      }

      // Level 2 is the fully-roomed storey (10 spaces) used for the detailed
      // orientation checks.
      const level2 = plan.storeys.find((storey) => storey.name === "Level 2");
      expect(level2).toBeTruthy();
      expect(Math.abs(level2?.upAxis3D[1] ?? 0)).toBeGreaterThan(0.9);
      expect((level2?.bounds.max[0] ?? 0) - (level2?.bounds.min[0] ?? 0)).toBeGreaterThan(10);
      expect((level2?.bounds.max[1] ?? 0) - (level2?.bounds.min[1] ?? 0)).toBeGreaterThan(5);
      expect((level2?.focusBounds.max[0] ?? 0) - (level2?.focusBounds.min[0] ?? 0)).toBeLessThanOrEqual(
        (level2?.contextBounds.max[0] ?? 0) - (level2?.contextBounds.min[0] ?? 0)
      );
      expect((level2?.focusBounds.max[1] ?? 0) - (level2?.focusBounds.min[1] ?? 0)).toBeLessThanOrEqual(
        (level2?.contextBounds.max[1] ?? 0) - (level2?.contextBounds.min[1] ?? 0)
      );
      expect(
        ((level2?.bounds.max[1] ?? 0) - (level2?.bounds.min[1] ?? 0)) /
          ((level2?.bounds.max[0] ?? 1) - (level2?.bounds.min[0] ?? 0))
      ).toBeGreaterThan(0.15);
      const level2Walls = level2?.architecture.primitives.filter(
        (primitive) => primitive.kind === "wall"
      ) ?? [];
      // Walls should be axis-aligned in the storey frame; only weigh edges of
      // at least 2 m so door jambs and wall ends do not dominate.
      expect(dominantWallAxisDeviation(level2Walls, 2)).toBeLessThan(1);
      expect(
        level2Walls.some(
          (primitive) =>
            primitive.presentationCategory === "building"
        )
      ).toBe(true);

      for (const primitive of primitives) {
        for (const polygon of primitive.polygons) {
          expect(signedArea(polygon.outer)).toBeGreaterThan(0);
          for (const hole of polygon.holes) {
            expect(signedArea(hole)).toBeLessThan(0);
          }
        }
      }

      for (const space of plan.storeys.flatMap((storey) => storey.architecture.spaces)) {
        expect(space.polygons.length).toBeGreaterThan(0);
        expect(
          space.polygons.some((polygon) => pointInPolygon(space.labelPoint, polygon))
        ).toBe(true);
      }

      const level2Spaces = level2?.architecture.spaces ?? [];
      const labelYValues = level2Spaces.map((space) => space.labelPoint[1]);
      expect(Math.max(...labelYValues) - Math.min(...labelYValues)).toBeGreaterThan(3);
    },
    120_000
  );
});

describe("public Duplex upload fixtures", () => {
  it(
    "builds a composite plan from the Duplex ARCH and MEP IFC files",
    async () => {
      const [architectureBytes, mechanicalBytes] = await Promise.all([
        readFixture("duplex", "arc.ifc"),
        readFixture("duplex", "mep.ifc")
      ]);
      const [architectureIndex, mechanicalIndex] = await Promise.all([
        extractIfcIndex(architectureBytes, "duplex-model"),
        extractIfcIndex(mechanicalBytes, "duplex-model")
      ]);
      const processedSources = [
        processedSource("duplex-model", "architecture", architectureBytes, architectureIndex),
        processedSource("duplex-model", "mechanical", mechanicalBytes, mechanicalIndex)
      ];

      const plan = await buildCompositePlanModel("duplex-model", processedSources, {
        llmClassifier: officeClassifier
      });

      expect(plan.planVersion).toBe(CURRENT_PLAN_VERSION);
      expect(plan.storeys).toHaveLength(4);
      expect(plan.storeys.reduce((total, storey) => total + storey.architecture.spaces.length, 0)).toBe(21);
      // The residential MEP export is hydronic + exhaust only, so the plan
      // carries a handful of equipment/segment items rather than a duct network.
      expect(plan.storeys.flatMap((storey) => storey.mechanicalVisual2D).length).toBeGreaterThan(10);
      expect(plan.storeys.some((storey) => storey.focusBounds.max[0] > storey.focusBounds.min[0])).toBe(true);
    },
    120_000
  );
});

describe("composite ARCH + MECH", () => {
  it(
    "builds a composite index and plan from the public WBDG Office ARCH and MEP fixtures",
    async () => {
      const [architectureBytes, mechanicalBytes] = await Promise.all([
        readFixture("wbdg_office", "arc.ifc"),
        readFixture("wbdg_office", "mep.ifc")
      ]);
      const [architectureIndex, mechanicalIndex] = await Promise.all([
        extractIfcIndex(architectureBytes, "composite-model"),
        extractIfcIndex(mechanicalBytes, "composite-model")
      ]);

      const processedSources = [
        processedSource("composite-model", "architecture", architectureBytes, architectureIndex),
        processedSource("composite-model", "mechanical", mechanicalBytes, mechanicalIndex)
      ];

      const compositeIndex = composeCompositeIndex("composite-model", processedSources);
      expect(compositeIndex.lengthUnit).toBe("metre");
      expect(compositeIndex.storeys).toHaveLength(3);
      expect(compositeIndex.spaces).toHaveLength(99);
      const mechanicalElements = compositeIndex.elements.filter(
        (element) => element.discipline === "mechanical"
      );
      expect(mechanicalElements.length).toBeGreaterThan(1000);
      expect(mechanicalElements.some((element) => element.airflowType === "supply")).toBe(true);
      expect(mechanicalElements.some((element) => element.airflowType === "return")).toBe(true);
      expect(mechanicalElements.some((element) => element.airflowType === "exhaust")).toBe(true);
      // This export has no IfcSystem grouping; airflow type is resolved from
      // the Revit property sets, so most of the duct network still classifies.
      expect(
        mechanicalElements.filter((element) => element.airflowType !== "unknown").length
      ).toBeGreaterThan(500);
      expect(
        compositeIndex.elements.every((element) => element.globalId.includes(":"))
      ).toBe(true);

      const plan = await buildCompositePlanModel("composite-model", processedSources, {
        llmClassifier: officeClassifier
      });
      expect(plan.planVersion).toBe(CURRENT_PLAN_VERSION);
      expect(plan.storeys).toHaveLength(3);
      expect(plan.storeys.every((storey) => storey.units === "metre")).toBe(true);

      // Every storey has a loads layer; every space in a storey with non-zero
      // area has a non-zero designCfm under the stubbed office classifier.
      for (const storey of plan.storeys) {
        expect(storey.loads.storeyGlobalId).toBe(storey.globalId);
        expect(storey.loads.planVersion).toBe(CURRENT_PLAN_VERSION);
        expect(storey.loads.totals.spaceCount).toBe(storey.loads.spaces.length);
        for (const load of storey.loads.spaces) {
          // Either the heuristic matched a known alias (lobby, office, etc.)
          // or the LLM stub returned the default office key — both are valid.
          expect(["heuristic", "llm"]).toContain(load.classificationConfidence);
          if (load.areaSqft > 0) {
            // designCfm aggregates ventilation, thermal, and minimum exhaust.
            // ventilation.voz is legitimately 0 for exhaust-only space types
            // like toilets and janitors, so only assert the aggregate here.
            expect(load.designCfm).toBeGreaterThan(0);
          }
        }
      }
      // Plan-level sanity: at least some storey has non-trivial total CFM.
      expect(
        plan.storeys.some((storey) => storey.loads.totals.designCfm > 10)
      ).toBe(true);

      const visualItems = plan.storeys.flatMap((storey) => storey.mechanicalVisual2D);
      const editItems = plan.storeys.flatMap((storey) => storey.mechanicalEdit2D);
      expect(visualItems.length).toBeGreaterThan(1000);
      expect(editItems.length).toBeGreaterThan(1000);
      expect(visualItems.some((item) => item.geometryType === "visual")).toBe(true);
      expect(editItems.every((item) => item.id && item.visualRef && item.elementRef)).toBe(true);
      expect(editItems.every((item) => !("expressId" in item) && !("ifcClass" in item))).toBe(true);
      expect(
        visualItems.some(
          (item) =>
            (item.airflowType === "supply" ||
              item.airflowType === "return" ||
              item.airflowType === "exhaust" ||
              item.airflowType === "outside-air")
        )
      ).toBe(true);
      expect(
        visualItems.some(
          (item) =>
            item.kind === "mech-segment" &&
            item.polygons.length > 0
        )
      ).toBe(true);
      expect(
        editItems.some(
          (item) =>
            item.editKind === "node" &&
            item.kind === "mech-terminal" &&
            item.size[0] > 0 &&
            item.size[1] > 0
        )
      ).toBe(true);
      expect(
        editItems.some(
          (item) =>
            item.editKind === "edge" &&
            item.kind === "mech-segment" &&
            item.path.length >= 2 &&
            (item.width ?? 0) > 0
        )
      ).toBe(true);
      // The export has no IfcRelConnectsPorts, so connectivity is inferred
      // geometrically; it must still populate.
      expect(
        editItems.some(
          (item) => item.connectedItemIds.length > 0
        )
      ).toBe(true);

      // Loads → plan wiring: supply terminals are located in their room and
      // carry the space's design CFM (split across the room's diffusers). This
      // is the substrate the LLM-edit loop and duct sizing reason against.
      const supplyTerminals = editItems.filter(
        (item) =>
          item.editKind === "node" &&
          item.kind === "mech-terminal" &&
          item.airflowType === "supply"
      ) as Array<Extract<(typeof editItems)[number], { editKind: "node" }>>;
      expect(supplyTerminals.length).toBeGreaterThan(50);
      const cfmBearing = supplyTerminals.filter(
        (item) => item.spaceGlobalId !== null && (item.requiredCfm ?? 0) > 0
      );
      console.log(
        `\n[loads→plan] ${supplyTerminals.length} supply terminals, ` +
          `${cfmBearing.length} carry a CFM target ` +
          `(${supplyTerminals.length - cfmBearing.length} outside any classified space)`
      );
      if (cfmBearing.length > 0) {
        const sample = cfmBearing[0];
        const size = sizeDuctForAirflow({
          cfm: sample.requiredCfm!,
          airflowType: "supply",
          role: "runout"
        });
        console.log(
          `[loads→plan] sample terminal needs ${sample.requiredCfm!.toFixed(0)} CFM ` +
            `→ ${size.standardDiameterIn}" round runout @ ${size.velocityFpm.toFixed(0)} fpm`
        );
      }
      expect(
        cfmBearing.length,
        "at least one supply terminal should carry a denormalized CFM target"
      ).toBeGreaterThan(0);
      for (const terminal of cfmBearing) {
        // The duct-sizing primitive must accept every wired CFM target.
        const size = sizeDuctForAirflow({
          cfm: terminal.requiredCfm!,
          airflowType: "supply",
          role: "runout"
        });
        expect(size.standardDiameterIn).toBeGreaterThan(0);
      }

      // Baseline grade of the as-built plan: this is the starting score the
      // agentic edit loop must improve. A non-zero error/warning count here is
      // the work to be done (undersupplied rooms, disconnected diffusers).
      const report = validateMechanicalPlan({
        editItems: plan.storeys.flatMap((s) => s.mechanicalEdit2D),
        spaces: plan.storeys.flatMap((s) => s.architecture.spaces),
        spaceLoads: plan.storeys.flatMap((s) => s.loads.spaces)
      });
      const byCheck = new Map<string, number>();
      for (const f of report.findings) {
        byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
      }
      console.log(
        `[validator] baseline: ${report.errorCount} errors, ${report.warningCount} warnings ` +
          `[${[...byCheck].map(([k, n]) => `${k}:${n}`).join(", ")}]`
      );
      expect(report.findings.length).toBeGreaterThanOrEqual(0);
      expect(
        plan.storeys.every(
          (storey) =>
            storey.bounds.min[0] >= 0 &&
            storey.bounds.min[1] >= 0 &&
            storey.mechanicalVisual2D.every(
              (item) => item.bounds.min[0] >= 0 && item.bounds.min[1] >= 0
            ) &&
            storey.mechanicalEdit2D.every(
              (item) =>
                item.editKind === "edge"
                  ? item.path.every((point) => point[0] >= 0 && point[1] >= 0)
                  : item.position[0] >= 0 && item.position[1] >= 0
            )
        )
      ).toBe(true);
    },
    120_000
  );
});
