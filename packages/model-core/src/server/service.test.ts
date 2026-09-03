import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createModelRecord,
  getModelSummary,
  replaceModelIndex,
  updateModelStatus,
  updatePlanStatus
} = vi.hoisted(() => ({
  createModelRecord: vi.fn(),
  getModelSummary: vi.fn(),
  replaceModelIndex: vi.fn(),
  updateModelStatus: vi.fn(),
  updatePlanStatus: vi.fn()
}));

const {
  getStorageAdapter
} = vi.hoisted(() => ({
  getStorageAdapter: vi.fn()
}));

const {
  extractIfcPlanModel
} = vi.hoisted(() => ({
  extractIfcPlanModel: vi.fn()
}));

vi.mock("./repository", () => ({
  createModelRecord,
  getModelSummary,
  replaceModelIndex,
  updateModelStatus,
  updatePlanStatus
}));

vi.mock("./storage", () => ({
  getStorageAdapter
}));

vi.mock("./plan", async () => {
  const actual = await vi.importActual<typeof import("./plan")>("./plan");
  return {
    ...actual,
    extractIfcPlanModel
  };
});

import { CURRENT_PLAN_VERSION } from "./plan";
import { getPlanModel } from "./service";

describe("getPlanModel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("hydrates a stored manifest and layer payloads into a plan model", async () => {
    const model = {
      id: "model-1",
      status: "ready",
      sourceKey: "models/model-1/source.ifc",
      planKey: "models/model-1/plan.json",
      planStatus: "ready"
    };
    const manifest = {
      modelId: "model-1",
      planVersion: CURRENT_PLAN_VERSION,
      schema: "IFC2X3",
      storeys: [
        {
          modelId: "model-1",
          planVersion: CURRENT_PLAN_VERSION,
          globalId: "storey-1",
          name: "Level 1",
          longName: null,
          elevation: 0,
          sortOrder: 0,
          units: "foot",
          origin3D: [0, 0, 0],
          uAxis3D: [1, 0, 0],
          vAxis3D: [0, 0, 1],
          upAxis3D: [0, 1, 0],
          worldBounds3D: {
            min: [0, 0, 0],
            max: [40, 3, 24]
          },
          bounds: {
            min: [0, 0],
            max: [40, 24]
          },
          contextBounds: {
            min: [0, 0],
            max: [40, 24]
          },
          focusBounds: {
            min: [2, 2],
            max: [20, 17]
          },
          layerKeys: {
            architecture: "models/model-1/plan/storey-1/architecture.json",
            mechanicalVisual2D: "models/model-1/plan/storey-1/mechanicalVisual2D.json",
            mechanicalEdit2D: "models/model-1/plan/storey-1/mechanicalEdit2D.json",
            loads: "models/model-1/plan/storey-1/loads.json"
          }
        }
      ]
    };
    const loadsLayer = {
      modelId: "model-1",
      storeyGlobalId: "storey-1",
      planVersion: CURRENT_PLAN_VERSION,
      spaces: [],
      totals: {
        designCfm: 0,
        ventilationCfm: 0,
        sensibleLoadBtuH: 0,
        spaceCount: 0
      }
    };
    const architectureLayer = {
      primitives: [
        {
          modelId: "model-1",
          sourceId: "architecture",
          discipline: "architecture",
          sourceGlobalId: "wall-0",
          globalId: "wall-0",
          compositeGlobalId: "wall-0",
          expressId: 10,
          ifcClass: "IFCWALL",
          storeyGlobalId: "storey-1",
          geometryType: "area",
          kind: "wall",
          polygons: [
            {
              outer: [
                [24, 0],
                [40, 0],
                [40, 24],
                [24, 24]
              ],
              holes: []
            }
          ],
          bounds: {
            min: [24, 0],
            max: [40, 24]
          },
          presentationCategory: "building",
          sourceName: "Perimeter Wall",
          diagnostics: []
        },
        {
          modelId: "model-1",
          sourceId: "architecture",
          discipline: "architecture",
          sourceGlobalId: "wall-1",
          globalId: "wall-1",
          compositeGlobalId: "wall-1",
          expressId: 11,
          ifcClass: "IFCWALL",
          storeyGlobalId: "storey-1",
          geometryType: "area",
          kind: "wall",
          polygons: [
            {
              outer: [
                [2, 2],
                [20, 2],
                [20, 4],
                [2, 4]
              ],
              holes: []
            }
          ],
          bounds: {
            min: [2, 2],
            max: [20, 4]
          },
          presentationCategory: "building",
          sourceName: "Wall",
          diagnostics: []
        }
      ],
      spaces: [
        {
          modelId: "model-1",
          sourceId: "architecture",
          discipline: "architecture",
          sourceGlobalId: "space-1",
          globalId: "space-1",
          compositeGlobalId: "space-1",
          expressId: 12,
          ifcClass: "IFCSPACE",
          storeyGlobalId: "storey-1",
          geometryType: "area",
          kind: "space",
          polygons: [
            {
              outer: [
                [3, 5],
                [17, 5],
                [17, 17],
                [3, 17]
              ],
              holes: []
            }
          ],
          bounds: {
            min: [3, 5],
            max: [17, 17]
          },
          presentationCategory: "building",
          sourceName: "Lobby",
          diagnostics: [],
          label: "LOBBY",
          secondaryLabel: null,
          area: 52,
          labelPoint: [10, 10]
        }
      ]
    };
    const storage = {
      getObject: vi.fn(async (key: string) => {
        if (key === "models/model-1/plan.json") {
          return { body: Buffer.from(JSON.stringify(manifest)) };
        }
        if (key === "models/model-1/plan/storey-1/architecture.json") {
          return { body: Buffer.from(JSON.stringify(architectureLayer)) };
        }
        if (key === "models/model-1/plan/storey-1/mechanicalVisual2D.json") {
          return { body: Buffer.from(JSON.stringify([])) };
        }
        if (key === "models/model-1/plan/storey-1/mechanicalEdit2D.json") {
          return { body: Buffer.from(JSON.stringify([])) };
        }
        if (key === "models/model-1/plan/storey-1/loads.json") {
          return { body: Buffer.from(JSON.stringify(loadsLayer)) };
        }
        throw new Error(`Unexpected key ${key}`);
      }),
      putObject: vi.fn(async () => undefined)
    };

    getModelSummary.mockResolvedValue(model);
    getStorageAdapter.mockReturnValue(storage);
    const upgraded = await getPlanModel(model.id);

    expect(upgraded?.planVersion).toBe(CURRENT_PLAN_VERSION);
    expect(upgraded?.storeys[0]?.units).toBe("foot");
    expect(upgraded?.storeys[0]?.contextBounds).toEqual({
      min: [0, 0],
      max: [40, 24]
    });
    expect(upgraded?.storeys[0]?.focusBounds).toEqual({
      min: [2, 2],
      max: [20, 17]
    });
    expect(upgraded?.storeys[0]?.architecture.primitives[0]?.presentationCategory).toBe("building");
    expect(upgraded?.storeys[0]?.architecture.spaces[0]?.presentationCategory).toBe("building");
    expect(extractIfcPlanModel).not.toHaveBeenCalled();
    expect(updatePlanStatus).not.toHaveBeenCalled();
  });

  it("returns the stored plan when the artifact version is current", async () => {
    const model = {
      id: "model-1",
      status: "ready",
      sourceKey: "models/model-1/source.ifc",
      planKey: "models/model-1/plan.json",
      planStatus: "ready"
    };
    const currentPlan = {
      modelId: "model-1",
      planVersion: CURRENT_PLAN_VERSION,
      schema: "IFC2X3",
      storeys: []
    };
    const storage = {
      getObject: vi.fn(async () => ({
        body: Buffer.from(JSON.stringify(currentPlan))
      })),
      putObject: vi.fn(async () => undefined)
    };

    getModelSummary.mockResolvedValue(model);
    getStorageAdapter.mockReturnValue(storage);

    await expect(getPlanModel(model.id)).resolves.toEqual(currentPlan);
    expect(extractIfcPlanModel).not.toHaveBeenCalled();
    expect(updatePlanStatus).not.toHaveBeenCalled();
  });

  it("falls back to the default plan key when the database plan key is missing", async () => {
    const model = {
      id: "model-1",
      status: "ready",
      sourceKey: "models/model-1/source.ifc",
      planKey: null,
      planStatus: "failed"
    };
    const currentPlan = {
      modelId: "model-1",
      planVersion: CURRENT_PLAN_VERSION,
      schema: "IFC2X3",
      storeys: []
    };
    const storage = {
      getObject: vi.fn(async (key: string) => {
        if (key !== "models/model-1/plan.json") {
          throw new Error(`Unexpected key ${key}`);
        }

        return {
          body: Buffer.from(JSON.stringify(currentPlan))
        };
      }),
      putObject: vi.fn(async () => undefined)
    };

    getModelSummary.mockResolvedValue(model);
    getStorageAdapter.mockReturnValue(storage);

    await expect(getPlanModel(model.id)).resolves.toEqual(currentPlan);
    expect(storage.getObject).toHaveBeenCalledWith("models/model-1/plan.json");
  });
});
