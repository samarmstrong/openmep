import type { ElementSummary, SpaceBoundary, SpaceSummary } from "../../types";

/**
 * Fail-loud gate on the envelope inputs that HVAC loads depend on.
 *
 * A Revit IFC export can carry every IfcSpace and still contain no building
 * elements at all (e.g. exported from a 3D view with only the Rooms category
 * visible). Every space boundary is then VIRTUAL, the geometric envelope
 * recovery has no walls/glazing to walk, and loads would silently degrade to
 * ventilation/internal-gain-only numbers that look plausible but are wrong.
 * This gate rejects that export with the fix spelled out, per the repo rule of
 * surfacing missing inputs instead of masking them.
 */

export type LoadInputCoverage = {
  spaceCount: number;
  elementCount: number;
  physicalBoundaryCount: number;
  externalBoundaryCount: number;
  externalAreaSqft: number;
};

export class LoadInputCoverageError extends Error {
  readonly coverage: LoadInputCoverage;

  constructor(message: string, coverage: LoadInputCoverage) {
    super(message);
    this.name = "LoadInputCoverageError";
    this.coverage = coverage;
  }
}

export function summarizeLoadInputCoverage(input: {
  spaces: ReadonlyArray<SpaceSummary>;
  elements: ReadonlyArray<ElementSummary>;
  boundaries: ReadonlyArray<SpaceBoundary>;
}): LoadInputCoverage {
  let physicalBoundaryCount = 0;
  let externalBoundaryCount = 0;
  let externalAreaSqft = 0;
  for (const boundary of input.boundaries) {
    if (boundary.boundaryType !== "physical") {
      continue;
    }
    physicalBoundaryCount += 1;
    if (boundary.internalOrExternal === "internal") {
      continue;
    }
    externalBoundaryCount += 1;
    if (boundary.areaSqft > 0) {
      externalAreaSqft += boundary.areaSqft;
    }
  }
  return {
    spaceCount: input.spaces.length,
    elementCount: input.elements.length,
    physicalBoundaryCount,
    externalBoundaryCount,
    externalAreaSqft
  };
}

/**
 * Throws when the model has spaces to compute loads for but no physical
 * surface bounds any of them. Models without spaces (e.g. a mechanical-only
 * source) are not load targets and pass through.
 */
export function assertLoadInputCoverage(input: {
  spaces: ReadonlyArray<SpaceSummary>;
  elements: ReadonlyArray<ElementSummary>;
  boundaries: ReadonlyArray<SpaceBoundary>;
}): LoadInputCoverage {
  const coverage = summarizeLoadInputCoverage(input);
  if (coverage.spaceCount === 0 || coverage.physicalBoundaryCount > 0) {
    return coverage;
  }
  throw new LoadInputCoverageError(
    `HVAC loads need an envelope: ${coverage.spaceCount} IfcSpace(s) but no physical ` +
      `space boundary reaches any of them (${coverage.elementCount} building element(s) ` +
      `in the model, ${input.boundaries.length} boundaries, all virtual). ` +
      "Re-export the architectural IFC from a 3D view in which walls, curtain walls, " +
      "roofs, floors, ceilings, windows and doors are visible — with 2nd-level space " +
      "boundaries enabled — or uncheck \"Export only elements visible in view\". " +
      "A rooms-only export cannot produce envelope loads.",
    coverage
  );
}
