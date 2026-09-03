import { describe, expect, it } from "vitest";

import { resolveContainingStoreyExpressId } from "./ifc-helpers";

const storeys = [{ expressId: 10 }, { expressId: 20 }] as never[];

describe("resolveContainingStoreyExpressId", () => {
  it("resolves direct storey containment", () => {
    expect(
      resolveContainingStoreyExpressId(
        {
          storeys,
          spatialContainerByExpressId: new Map([[100, 10]]),
          aggregateParentByExpressId: new Map()
        },
        100
      )
    ).toBe(10);
  });

  it("walks element → IfcSpace → storey (Revit MEP containment)", () => {
    expect(
      resolveContainingStoreyExpressId(
        {
          storeys,
          spatialContainerByExpressId: new Map([[100, 55]]),
          aggregateParentByExpressId: new Map([[55, 20]])
        },
        100
      )
    ).toBe(20);
  });

  it("walks nested aggregates and returns null when no storey is reached", () => {
    const context = {
      storeys,
      spatialContainerByExpressId: new Map<number, number>(),
      aggregateParentByExpressId: new Map([
        [100, 70],
        [70, 71],
        [71, 10]
      ])
    };
    expect(resolveContainingStoreyExpressId(context, 100)).toBe(10);
    expect(resolveContainingStoreyExpressId(context, 999)).toBeNull();
  });

  it("terminates on cyclic relationships", () => {
    expect(
      resolveContainingStoreyExpressId(
        {
          storeys,
          spatialContainerByExpressId: new Map([[1, 2]]),
          aggregateParentByExpressId: new Map([[2, 1]])
        },
        1
      )
    ).toBeNull();
  });
});
