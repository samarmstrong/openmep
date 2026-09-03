// @vitest-environment jsdom

import type { ModelSummary, PlanStorey, SpaceSummary, StoreySummary } from "@mep/model-core";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { searchParamsMock } = vi.hoisted(() => ({
  searchParamsMock: vi.fn(() => new URLSearchParams())
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParamsMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/models/model-1"
}));

vi.mock("./ifc-viewer", () => ({
  IfcViewer: () => React.createElement("div", { "data-testid": "ifc-viewer" })
}));

vi.mock("./plan-canvas", () => ({
  PlanCanvas: () => React.createElement("div", { "data-testid": "plan-canvas" })
}));

import { ModelWorkspace } from "./model-workspace";

const modelId = "model-1";

const readyModel: ModelSummary = {
  id: modelId,
  name: "Ready Model",
  status: "ready",
  schema: "IFC2X3",
  sourceKey: "source",
  fragmentsKey: "fragments",
  indexKey: "index",
  planKey: "plan",
  planStatus: "ready",
  readyForViewer: true,
  readyForPlan: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  counts: {
    storeys: 1,
    spaces: 1,
    elements: 10
  },
  fragmentsUrl: `/api/models/${modelId}/fragments`,
  planUrl: `/api/models/${modelId}/plan`,
  errorMessage: null,
  planErrorMessage: null,
  sources: [
    {
      modelId,
      sourceId: "arch-source",
      discipline: "architecture" as const,
      name: "Architecture",
      status: "ready" as const,
      schema: "IFC2X3",
      sourceKey: "arch-key",
      fragmentsKey: "frags",
      indexKey: "idx",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      counts: { storeys: 1, spaces: 1, elements: 10 },
      fragmentsUrl: `/api/models/${modelId}/fragments`,
      errorMessage: null
    }
  ]
};

const processingModel: ModelSummary = {
  ...readyModel,
  status: "processing",
  planStatus: "processing",
  readyForViewer: false,
  readyForPlan: false,
  fragmentsKey: null,
  fragmentsUrl: null,
  planKey: null,
  planUrl: null
};

const storeys: StoreySummary[] = [
  {
    modelId,
    expressId: 1,
    globalId: "storey-1",
    name: "Level 1",
    longName: null,
    elevation: 0,
    sortOrder: 0,
    placement: [0, 0, 0],
    bounds: null
  }
];

const spaces: SpaceSummary[] = [
  {
    modelId,
    sourceId: "architecture",
    discipline: "architecture",
    expressId: 10,
    sourceGlobalId: "space-1",
    globalId: "space-1",
    compositeGlobalId: "space-1",
    name: "100",
    longName: "LOBBY / CIRCULATION",
    storeyGlobalId: "storey-1",
    area: 52,
    placement: [0, 0, 0],
    bounds: null,
    properties: {}
  }
];

const planStorey: PlanStorey = {
  modelId,
  planVersion: 5,
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
    max: [20, 3, 20]
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
    max: [20, 20]
  },
  architecture: {
    primitives: [
      {
        modelId,
        sourceId: "architecture",
        discipline: "architecture",
        sourceGlobalId: "wall-1",
        globalId: "wall-1",
        compositeGlobalId: "wall-1",
        expressId: 10,
        ifcClass: "IFCWALLSTANDARDCASE",
        storeyGlobalId: "storey-1",
        geometryType: "area",
        kind: "wall",
        polygons: [{ outer: [[2, 2], [18, 2], [18, 4], [2, 4]], holes: [] }],
        bounds: { min: [2, 2], max: [18, 4] },
        presentationCategory: "building",
        sourceName: "Wall 1",
        diagnostics: []
      }
    ],
    spaces: [
      {
        modelId,
        sourceId: "architecture",
        discipline: "architecture",
        sourceGlobalId: "space-1",
        globalId: "space-1",
        compositeGlobalId: "space-1",
        expressId: 20,
        ifcClass: "IFCSPACE",
        storeyGlobalId: "storey-1",
        geometryType: "area",
        kind: "space",
        polygons: [{ outer: [[3, 5], [17, 5], [17, 17], [3, 17]], holes: [] }],
        bounds: { min: [3, 5], max: [17, 17] },
        presentationCategory: "building",
        sourceName: "Lobby",
        diagnostics: [],
        label: "LOBBY / CIRCULATION",
        secondaryLabel: "100",
        area: 52,
        labelPoint: [10, 11]
      }
    ]
  },
  mechanicalVisual2D: [],
  mechanicalEdit2D: [],
  loads: {
    modelId,
    storeyGlobalId: "storey-1",
    planVersion: 5,
    spaces: [
      {
        spaceGlobalId: "space-1",
        storeyGlobalId: "storey-1",
        areaSqft: 560,
        occupants: 3,
        spaceTypeKey: "offices-commercial-general",
        spaceTypeDisplayName: "Offices, Commercial - General",
        classificationConfidence: "heuristic",
        ventilation: {
          ra: 0.06,
          rp: 5,
          ez: 0.8,
          vbz: 48.6,
          voz: 60.75
        },
        thermal: {
          sensibleLoadBtuH: 5200,
          supplyDeltaTF: 20,
          cfm: 240.74,
          internalBtuH: 5200,
          envelopeBtuH: 0, solarBtuH: 0,
          envelopeBreakdown: {}
        },
        estimator: {
          cfmPerSqft: 1,
          cfm: 560
        },
        designCfm: 560,
        diagnostics: []
      }
    ],
    totals: {
      designCfm: 560,
      ventilationCfm: 60.75,
      sensibleLoadBtuH: 0,
      envelopeBtuH: 0,
      solarBtuH: 0, spaceCount: 1
    },
    climate: null
  }
};

function mockJsonResponse(payload: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => payload
  } as Response);
}

async function flushWorkspace() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ModelWorkspace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    searchParamsMock.mockReturnValue(new URLSearchParams());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders the app shell with 3D/2D/Plan mode toggle", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/models/${modelId}`)) return mockJsonResponse(readyModel);
      if (url.endsWith(`/api/models/${modelId}/storeys`)) return mockJsonResponse({ items: storeys });
      if (url.includes(`/api/models/${modelId}/spaces?storeyId=`)) return mockJsonResponse({ items: spaces });
      throw new Error(`Unexpected fetch ${url}`);
    }));

    render(React.createElement(ModelWorkspace, { modelId }));

    await act(async () => { await flushWorkspace(); });

    expect(screen.getByText("MEPFLOW")).toBeTruthy();
    expect(screen.getByRole("button", { name: "3D" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2D" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    expect(screen.getByTestId("ifc-viewer")).toBeTruthy();
  });

  it("stops polling once the model is ready", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/models/${modelId}`)) return mockJsonResponse(readyModel);
      if (url.endsWith(`/api/models/${modelId}/storeys`)) return mockJsonResponse({ items: storeys });
      if (url.includes(`/api/models/${modelId}/spaces?storeyId=`)) return mockJsonResponse({ items: spaces });
      throw new Error(`Unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(ModelWorkspace, { modelId }));

    await act(async () => { await flushWorkspace(); });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });

    const modelRequests = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith(`/api/models/${modelId}`)
    );
    expect(modelRequests).toHaveLength(1);
  });

  it("polls while processing and stops after the model becomes ready", async () => {
    const fetchMock = vi.fn();
    let modelFetches = 0;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/models/${modelId}`)) {
        modelFetches += 1;
        return mockJsonResponse(modelFetches === 1 ? processingModel : readyModel);
      }
      if (url.endsWith(`/api/models/${modelId}/storeys`)) return mockJsonResponse({ items: storeys });
      if (url.includes(`/api/models/${modelId}/spaces?storeyId=`)) return mockJsonResponse({ items: spaces });
      throw new Error(`Unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(ModelWorkspace, { modelId }));

    await act(async () => { await flushWorkspace(); });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
      await flushWorkspace();
    });

    const polledModelRequests = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith(`/api/models/${modelId}`)
    );
    expect(polledModelRequests).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    const modelRequests = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith(`/api/models/${modelId}`)
    );
    expect(modelRequests).toHaveLength(2);
  });

  it("switches to plan mode and renders PlanCanvas instead of IfcViewer", async () => {
    vi.useRealTimers();

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/models/${modelId}`)) return mockJsonResponse(readyModel);
      if (url.endsWith(`/api/models/${modelId}/storeys`)) return mockJsonResponse({ items: storeys });
      if (url.includes(`/api/models/${modelId}/spaces?storeyId=`)) return mockJsonResponse({ items: spaces });
      if (url.includes(`/api/models/${modelId}/plan?storeyId=`)) return mockJsonResponse(planStorey);
      throw new Error(`Unexpected fetch ${url}`);
    }));

    render(React.createElement(ModelWorkspace, { modelId }));

    await waitFor(() => {
      expect(screen.getByTestId("ifc-viewer")).toBeTruthy();
    });

    expect(screen.queryByTestId("plan-canvas")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));

    await waitFor(() => {
      expect(screen.queryByTestId("ifc-viewer")).toBeNull();
      expect(screen.getByTestId("plan-canvas")).toBeTruthy();
      expect(screen.getByLabelText("Storey CFM summary").textContent).toContain("560");
    });
  });

  it("shows a loading state while plan layers are fetched", async () => {
    vi.useRealTimers();

    let resolvePlan: ((response: Response) => void) | null = null;
    const planResponse = new Promise<Response>((resolve) => {
      resolvePlan = resolve;
    });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/models/${modelId}`)) return mockJsonResponse(readyModel);
      if (url.endsWith(`/api/models/${modelId}/storeys`)) return mockJsonResponse({ items: storeys });
      if (url.includes(`/api/models/${modelId}/spaces?storeyId=`)) return mockJsonResponse({ items: spaces });
      if (url.includes(`/api/models/${modelId}/plan?storeyId=`)) return planResponse;
      throw new Error(`Unexpected fetch ${url}`);
    }));

    render(React.createElement(ModelWorkspace, { modelId }));

    await waitFor(() => {
      expect(screen.getByTestId("ifc-viewer")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));

    await waitFor(() => {
      expect(screen.getByText("Loading plan view...")).toBeTruthy();
    });

    await act(async () => {
      resolvePlan?.(await mockJsonResponse(planStorey));
      await flushWorkspace();
    });

    await waitFor(() => {
      expect(screen.queryByText("Loading plan view...")).toBeNull();
      expect(screen.getByTestId("plan-canvas")).toBeTruthy();
    });
  });

  it("marks capture-mode plan fetches as read-only", async () => {
    vi.useRealTimers();
    searchParamsMock.mockReturnValue(
      new URLSearchParams({
        mode: "plan",
        storeyId: "storey-1",
        capture: "plan",
        editOverlay: "1"
      })
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/models/${modelId}`)) return mockJsonResponse(readyModel);
      if (url.endsWith(`/api/models/${modelId}/storeys`)) return mockJsonResponse({ items: storeys });
      if (url.includes(`/api/models/${modelId}/plan?`)) return mockJsonResponse(planStorey);
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(ModelWorkspace, { modelId }));

    await waitFor(() => {
      expect(screen.getByTestId("plan-canvas")).toBeTruthy();
    });

    const planRequest = fetchMock.mock.calls.find(([url]) =>
      String(url).includes(`/api/models/${modelId}/plan?`)
    );
    expect(planRequest).toBeDefined();
    expect(new URL(String(planRequest?.[0]), "http://localhost").searchParams.get("readOnly")).toBe("1");
  });

  it("polls capture-mode plan data so artifact edits rerender", async () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams({
        mode: "plan",
        storeyId: "storey-1",
        capture: "plan",
        editOverlay: "1"
      })
    );
    const updatedPlanStorey: PlanStorey = {
      ...planStorey,
      loads: {
        ...planStorey.loads,
        totals: {
          ...planStorey.loads.totals,
          designCfm: 777
        }
      }
    };
    let planFetches = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/models/${modelId}`)) return mockJsonResponse(readyModel);
      if (url.endsWith(`/api/models/${modelId}/storeys`)) return mockJsonResponse({ items: storeys });
      if (url.includes(`/api/models/${modelId}/plan?`)) {
        planFetches += 1;
        return mockJsonResponse(planFetches === 1 ? planStorey : updatedPlanStorey);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(ModelWorkspace, { modelId }));

    await act(async () => { await flushWorkspace(); });

    expect(screen.getByLabelText("Storey CFM summary").textContent).toContain("560");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushWorkspace();
    });

    expect(screen.getByLabelText("Storey CFM summary").textContent).toContain("777");
    const planRequests = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes(`/api/models/${modelId}/plan?`)
    );
    expect(planRequests).toHaveLength(2);
    expect(new URL(String(planRequests[0]?.[0]), "http://localhost").searchParams.get("readOnly")).toBe("1");
    expect(new URL(String(planRequests[1]?.[0]), "http://localhost").searchParams.get("poll")).toBeTruthy();
  });
});
