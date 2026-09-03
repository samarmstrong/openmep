import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { publicFixturePath } from "../../test/fixtures";
import { extractIfcIndex } from "../ifc";
import { classifyAssembly } from "./assemblies";
import { classifySpaces } from "./classify";
import { computeStoreyLoads } from "./calculate";
import { resolveClimate } from "./climate";

/**
 * Exercises the envelope-conduction path against the public buildingSMART
 * Duplex fixture, a Revit export that carries 1st-level IfcRelSpaceBoundary.
 * Prints per-space envelope load and asserts the path actually fires: climate
 * resolves, glazing and wall area are recovered geometrically, and at least one
 * perimeter space becomes cooling-driven.
 *
 * Bands were measured on 2026-09-02 (glazing 794 ft², walls 7014 ft², 522
 * ft²/ton with every heuristic miss classified as general office) and widened
 * by about ±25% so small pipeline changes do not churn this test.
 */
describe("public Duplex envelope check", () => {
  it(
    "computes cooling-driven loads from geometrically recovered Duplex glazing",
    async () => {
      const ifcPath = publicFixturePath("duplex", "arc.ifc");
      const bytes = new Uint8Array(await readFile(ifcPath));
      const index = await extractIfcIndex(bytes, "envelope-public-fixture");

      const climate = resolveClimate(index.site);

      console.log(`\n=== ${path.basename(path.dirname(ifcPath))}/${path.basename(ifcPath)} ===`);
      console.log(`schema: ${index.schema}, lengthUnit: ${index.lengthUnit}`);
      console.log(
        `${index.storeys.length} storeys, ${index.spaces.length} spaces, ` +
          `${index.elements.length} elements, ${index.boundaries.length} space boundaries`
      );
      console.log(
        `site: ${index.site.latitude ?? "?"}, ${index.site.longitude ?? "?"} → ` +
          `climate ${climate ? `${climate.zone} (${climate.representativeCity}), cooling DB ${climate.design.coolingDryBulbF}°F` : "UNRESOLVED"}`
      );

      // Boundary exposure breakdown (what the envelope calc keys off).
      const exposureCounts = new Map<string, number>();
      for (const b of index.boundaries) {
        const key = `${b.boundaryType}/${b.internalOrExternal}`;
        exposureCounts.set(key, (exposureCounts.get(key) ?? 0) + 1);
      }
      console.log("boundary types:");
      for (const [key, count] of [...exposureCounts].sort()) {
        console.log(`  ${key.padEnd(24)} ${count}`);
      }

      expect(climate, "site lat/lon should resolve to a climate zone").not.toBeNull();
      expect(index.boundaries.length).toBeGreaterThan(100);

      // Deterministic offline classification for the residential room names
      // the heuristics do not recognise.
      const classifications = await classifySpaces(index.spaces, {
        llmClassifier: async (spaces) =>
          new Map(spaces.map((space) => [space.globalId, "offices-commercial-general"]))
      });
      const elementsByGlobalId = new Map(
        index.elements.map((element) => [element.globalId, element])
      );
      let recoveredGlazingAreaSqft = 0;
      let recoveredWallAreaSqft = 0;
      for (const boundary of index.boundaries) {
        if (
          boundary.boundaryType !== "physical" ||
          boundary.internalOrExternal !== "external"
        ) {
          continue;
        }
        const element = elementsByGlobalId.get(boundary.elementGlobalId);
        const assembly = element
          ? classifyAssembly(element, boundary.internalOrExternal)
          : null;
        if (
          assembly === "fenestration-vertical" ||
          assembly === "fenestration-skylight" ||
          assembly === "door-glass"
        ) {
          recoveredGlazingAreaSqft += boundary.areaSqft;
        } else if (assembly?.startsWith("wall-")) {
          recoveredWallAreaSqft += boundary.areaSqft;
        }
      }
      console.log(
        `geometric envelope reaching loads: glazing ${recoveredGlazingAreaSqft.toFixed(0)} ft², ` +
          `walls ${recoveredWallAreaSqft.toFixed(0)} ft²`
      );
      expect(recoveredGlazingAreaSqft).toBeGreaterThan(0);
      expect(recoveredGlazingAreaSqft).toBeGreaterThanOrEqual(600);
      expect(recoveredGlazingAreaSqft).toBeLessThanOrEqual(1000);
      expect(recoveredWallAreaSqft).toBeGreaterThanOrEqual(5200);
      expect(recoveredWallAreaSqft).toBeLessThanOrEqual(8800);

      // Diagnostic: what do the load-bearing (physical/external) boundaries
      // actually reference, how much area, and does the classifier accept them?
      type Tally = {
        count: number;
        areaSqft: number;
        classified: Map<string, number>;
        unclassified: number;
      };
      const byElementClass = new Map<string, Tally>();
      for (const b of index.boundaries) {
        if (b.boundaryType !== "physical" || b.internalOrExternal === "internal") {
          continue;
        }
        const element = elementsByGlobalId.get(b.elementGlobalId);
        const ifcClass = element?.ifcClass ?? "(missing element)";
        const tally = byElementClass.get(ifcClass) ?? {
          count: 0,
          areaSqft: 0,
          classified: new Map<string, number>(),
          unclassified: 0
        };
        tally.count += 1;
        tally.areaSqft += b.areaSqft;
        const assembly = element
          ? classifyAssembly(element, b.internalOrExternal)
          : null;
        if (assembly) {
          tally.classified.set(assembly, (tally.classified.get(assembly) ?? 0) + 1);
        } else {
          tally.unclassified += 1;
        }
        byElementClass.set(ifcClass, tally);
      }
      console.log("\nphysical/external boundaries by related element class:");
      for (const [ifcClass, t] of [...byElementClass].sort(
        (a, b) => b[1].areaSqft - a[1].areaSqft
      )) {
        const cls = [...t.classified].map(([k, n]) => `${k}×${n}`).join(", ");
        console.log(
          `  ${ifcClass.padEnd(20)} ${t.count.toString().padStart(3)} bnd  ` +
            `${t.areaSqft.toFixed(0).padStart(7)} ft²  ` +
            `→ ${cls || "(none)"}${t.unclassified ? `, unclassified×${t.unclassified}` : ""}`
        );
      }
      const boundariesBySpaceGlobalId = new Map<string, typeof index.boundaries>();
      for (const boundary of index.boundaries) {
        const bucket = boundariesBySpaceGlobalId.get(boundary.spaceGlobalId) ?? [];
        bucket.push(boundary);
        boundariesBySpaceGlobalId.set(boundary.spaceGlobalId, bucket);
      }

      let grandCfm = 0;
      let grandEnvelope = 0;
      let grandSolar = 0;
      let grandSensible = 0;
      let grandArea = 0;
      let spacesWithEnvelope = 0;
      const coolingDrivenSpaces: typeof index.spaces = [];

      for (const storey of index.storeys) {
        const storeySpaces = index.spaces.filter(
          (s) => s.storeyGlobalId === storey.globalId
        );
        if (storeySpaces.length === 0) continue;

        const loads = computeStoreyLoads({
          modelId: "envelope-public-fixture",
          planVersion: 1,
          storeyGlobalId: storey.globalId,
          spaces: storeySpaces,
          classifications,
          lengthUnit: index.lengthUnit,
          boundariesBySpaceGlobalId,
          elementsByGlobalId,
          climate
        });

        console.log(
          `\n[${storey.name}]  ${loads.totals.spaceCount} spaces  →  ` +
            `design ${loads.totals.designCfm.toFixed(0)} CFM, ` +
            `envelope ${loads.totals.envelopeBtuH.toFixed(0)} Btu/h`
        );

        for (const sl of [...loads.spaces].sort(
          (a, b) => b.thermal.envelopeBtuH - a.thermal.envelopeBtuH
        )) {
          const nBoundaries =
            boundariesBySpaceGlobalId.get(sl.spaceGlobalId)?.length ?? 0;
          if (sl.thermal.envelopeBtuH > 0) spacesWithEnvelope += 1;
          const brk = Object.entries(sl.thermal.envelopeBreakdown)
            .filter(([, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k} ${Math.round(v)}`)
            .join(", ");
          const label = `${sl.spaceTypeDisplayName}`.padEnd(40);
          const driver =
            Math.abs(sl.designCfm - sl.thermal.cfm) <= Math.max(1, sl.designCfm * 0.01)
              ? "cool "
              : Math.abs(sl.designCfm - sl.ventilation.voz) <= Math.max(1, sl.designCfm * 0.01)
                ? "vent "
                : Math.abs(sl.designCfm - sl.estimator.cfm) <= Math.max(1, sl.designCfm * 0.01)
                  ? "estim"
                  : "other";
          if (driver === "cool ") {
            coolingDrivenSpaces.push(
              index.spaces.find((space) => space.globalId === sl.spaceGlobalId)!
            );
          }
          console.log(
            `  ${label} ${sl.areaSqft.toFixed(0).padStart(6)} ft²  ` +
              `${nBoundaries.toString().padStart(3)} bnd  →  ` +
              `env ${sl.thermal.envelopeBtuH.toFixed(0).padStart(7)} Btu/h  ` +
              `solar ${sl.thermal.solarBtuH.toFixed(0).padStart(7)} Btu/h  ` +
              `design ${sl.designCfm.toFixed(0).padStart(5)} CFM (${driver})` +
              (brk ? `  [${brk}]` : "")
          );
        }

        grandCfm += loads.totals.designCfm;
        grandEnvelope += loads.totals.envelopeBtuH;
        grandSolar += loads.totals.solarBtuH;
        grandSensible += loads.totals.sensibleLoadBtuH;
        grandArea += loads.spaces.reduce((sum, sl) => sum + sl.areaSqft, 0);
      }

      const ft2PerTon = grandArea / (grandSensible / 12_000);
      console.log(`\n===== BUILDING TOTAL =====`);
      console.log(`Design CFM:        ${grandCfm.toFixed(0)}`);
      console.log(`Envelope load:     ${grandEnvelope.toFixed(0)} Btu/h`);
      console.log(`Solar load:        ${grandSolar.toFixed(0)} Btu/h`);
      console.log(`Sensible cooling:  ${grandSensible.toFixed(0)} Btu/h`);
      console.log(`ft²/ton:           ${ft2PerTon.toFixed(0)}`);
      console.log(`Spaces w/ envelope: ${spacesWithEnvelope}`);
      console.log(`Cooling-driven spaces: ${coolingDrivenSpaces.length}`);

      expect(
        spacesWithEnvelope,
        "at least one space should get a non-zero envelope conduction load"
      ).toBeGreaterThan(0);
      expect(grandEnvelope).toBeGreaterThan(0);
      expect(grandSolar).toBeGreaterThan(0);
      expect(
        coolingDrivenSpaces.length,
        "at least one perimeter glazed space should be cooling-driven"
      ).toBeGreaterThan(0);
      expect(ft2PerTon).toBeGreaterThanOrEqual(390);
      expect(ft2PerTon).toBeLessThanOrEqual(660);
    },
    180_000
  );
});
