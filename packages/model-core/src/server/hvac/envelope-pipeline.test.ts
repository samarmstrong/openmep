import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { SpaceBoundary } from "../../types";
import { publicFixturePath } from "../../test/fixtures";
import { extractIfcIndex } from "../ifc";
import { computeStoreyLoads } from "./calculate";
import { classifySpaces } from "./classify";
import { resolveClimate } from "./climate";

/**
 * End-to-end check of the envelope wiring against the public buildingSMART
 * Duplex fixture (Chicago site). The test computes loads once with no
 * boundaries (envelope must be exactly 0), then injects one synthetic external
 * wall boundary and confirms it flows extract → climate → envelope → thermal →
 * computeStoreyLoads and raises the space's sensible load and storey total.
 */
describe("envelope load pipeline", () => {
  it(
    "resolves the Duplex site to a cold climate and adds envelope load to a perimeter space",
    async () => {
      const bytes = new Uint8Array(await readFile(publicFixturePath("duplex", "arc.ifc")));
      const index = await extractIfcIndex(bytes, "envelope-pipeline");

      const climate = resolveClimate(index.site);
      expect(climate, "Duplex site should resolve to a climate").not.toBeNull();
      // Chicago is ASHRAE 5A; the coarse nearest-anchor resolver currently
      // snaps it to the 6A anchor. Either is a valid cold-climate resolution.
      expect(["5A", "6A"]).toContain(climate?.zone);

      // Foundation/roof datum levels carry no rooms; use the first storey that
      // has measurable spaces.
      const storey = index.storeys.find((candidate) =>
        index.spaces.some(
          (space) => space.storeyGlobalId === candidate.globalId && (space.area ?? 0) > 0
        )
      );
      expect(storey, "fixture should have a storey with rooms").toBeTruthy();
      const storeySpaces = index.spaces.filter(
        (space) => space.storeyGlobalId === storey!.globalId && (space.area ?? 0) > 0
      );
      expect(storeySpaces.length).toBeGreaterThan(0);
      const target = storeySpaces[0];

      const wall = index.elements.find((element) => /IFCWALL/i.test(element.ifcClass));
      expect(wall, "model should contain at least one wall").toBeTruthy();

      const classifications = await classifySpaces(storeySpaces, {
        llmClassifier: async (spaces) =>
          new Map(spaces.map((space) => [space.globalId, "offices-commercial-general"]))
      });

      const baseInput = {
        modelId: "envelope-pipeline",
        planVersion: 1,
        storeyGlobalId: storey!.globalId,
        spaces: storeySpaces,
        classifications,
        lengthUnit: index.lengthUnit
      };

      const withoutEnvelope = computeStoreyLoads(baseInput);

      const boundary: SpaceBoundary = {
        modelId: "envelope-pipeline",
        spaceGlobalId: target.globalId,
        elementGlobalId: wall!.globalId,
        boundaryType: "physical",
        internalOrExternal: "external",
        areaSqft: 400,
        orientationDegrees: null
      };
      const withEnvelope = computeStoreyLoads({
        ...baseInput,
        boundariesBySpaceGlobalId: new Map([[target.globalId, [boundary]]]),
        elementsByGlobalId: new Map(index.elements.map((e) => [e.globalId, e])),
        climate
      });

      const before = withoutEnvelope.spaces.find((s) => s.spaceGlobalId === target.globalId)!;
      const after = withEnvelope.spaces.find((s) => s.spaceGlobalId === target.globalId)!;

      expect(before.thermal.envelopeBtuH).toBe(0);
      expect(after.thermal.envelopeBtuH).toBeGreaterThan(0);
      expect(after.thermal.sensibleLoadBtuH).toBeGreaterThan(before.thermal.sensibleLoadBtuH);
      // designCfm is a MAX across drivers, so envelope can only hold or raise it.
      expect(after.designCfm).toBeGreaterThanOrEqual(before.designCfm);
      expect(withEnvelope.totals.envelopeBtuH).toBeGreaterThan(0);
      expect(withEnvelope.climate?.zone).toBe(climate?.zone);
    },
    180_000
  );
});
