// @vitest-environment jsdom

import type { PlanStorey, StoreySummary } from "@mep/model-core";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoadDashboard } from "./load-dashboard";

const modelId = "model-1";

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

function planSpace(
  globalId: string,
  label: string,
  outer: [number, number][],
  labelPoint: [number, number],
  area: number
) {
  return {
    modelId,
    sourceId: "architecture" as const,
    discipline: "architecture" as const,
    sourceGlobalId: globalId,
    globalId,
    compositeGlobalId: globalId,
    expressId: 1,
    ifcClass: "IFCSPACE",
    storeyGlobalId: "storey-1",
    geometryType: "area" as const,
    kind: "space" as const,
    polygons: [{ outer, holes: [] }],
    bounds: {
      min: [Math.min(...outer.map((p) => p[0])), Math.min(...outer.map((p) => p[1]))] as [
        number,
        number
      ],
      max: [Math.max(...outer.map((p) => p[0])), Math.max(...outer.map((p) => p[1]))] as [
        number,
        number
      ]
    },
    presentationCategory: "building" as const,
    sourceName: label,
    diagnostics: [],
    label,
    secondaryLabel: null,
    area,
    labelPoint
  };
}

// Office: cooling-load driven, with a real envelope-conduction contribution.
const officeLoad = {
  spaceGlobalId: "office-1",
  storeyGlobalId: "storey-1",
  spaceTypeKey: "offices-commercial-general",
  spaceTypeDisplayName: "Offices, Commercial - General",
  classificationConfidence: "heuristic" as const,
  areaSqft: 295,
  occupants: 3,
  ventilation: { ra: 0.06, rp: 5, ez: 0.8, vbz: 48.6, voz: 60 },
  thermal: {
    sensibleLoadBtuH: 3645,
    supplyDeltaTF: 20,
    cfm: 295,
    internalBtuH: 3000,
    envelopeBtuH: 645, solarBtuH: 0,
    envelopeBreakdown: { "wall-steel-frame": 645 }
  },
  estimator: { cfmPerSqft: 1, cfm: 295 },
  designCfm: 295,
  diagnostics: []
};

// Toilet: exhaust-minimum driven (designCfm exceeds Voz, cooling, and estimator).
const toiletLoad = {
  spaceGlobalId: "toilet-1",
  storeyGlobalId: "storey-1",
  spaceTypeKey: "toilets-public-light",
  spaceTypeDisplayName: "Toilets - Public (light)",
  classificationConfidence: "heuristic" as const,
  areaSqft: 218,
  occupants: 5,
  ventilation: { ra: 0, rp: 0, ez: 0.8, vbz: 0, voz: 50 },
  thermal: {
    sensibleLoadBtuH: 1000,
    supplyDeltaTF: 20,
    cfm: 40,
    internalBtuH: 966,
    envelopeBtuH: 34, solarBtuH: 0,
    envelopeBreakdown: { "wall-steel-frame": 34 }
  },
  estimator: { cfmPerSqft: 0, cfm: 0 },
  designCfm: 131,
  diagnostics: ["design CFM is driven by minimum exhaust rate"]
};

const planStorey: PlanStorey = {
  modelId,
  planVersion: 1,
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
  worldBounds3D: { min: [0, 0, 0], max: [40, 3, 24] },
  bounds: { min: [0, 0], max: [40, 24] },
  contextBounds: { min: [0, 0], max: [40, 24] },
  focusBounds: { min: [0, 0], max: [40, 24] },
  architecture: {
    primitives: [],
    spaces: [
      planSpace("office-1", "OFFICE 101", [[2, 2], [20, 2], [20, 18], [2, 18]], [11, 10], 295),
      planSpace("toilet-1", "WC 102", [[22, 2], [38, 2], [38, 12], [22, 12]], [30, 7], 218)
    ]
  },
  mechanicalVisual2D: [],
  mechanicalEdit2D: [],
  loads: {
    modelId,
    storeyGlobalId: "storey-1",
    planVersion: 1,
    spaces: [officeLoad, toiletLoad],
    totals: {
      designCfm: 426,
      ventilationCfm: 110,
      sensibleLoadBtuH: 4645,
      envelopeBtuH: 679,
      solarBtuH: 0, spaceCount: 2
    },
    climate: {
      zone: "5A",
      representativeCity: "Boston, MA",
      coolingDryBulbF: 89,
      heatingDryBulbF: 9
    }
  }
};

function mockJsonResponse(payload: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => payload
  } as Response);
}

function renderDashboard() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/models/${modelId}/plan?`)) {
        return mockJsonResponse(planStorey);
      }
      throw new Error(`Unexpected fetch ${url}`);
    })
  );
  return render(
    React.createElement(LoadDashboard, {
      modelId,
      storeys,
      selectedStoreyId: "storey-1",
      onStoreyChange: vi.fn(),
      onClose: vi.fn()
    })
  );
}

describe("LoadDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("fetches loads and renders KPI totals grounded in the data", async () => {
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Load Calculations")).toBeTruthy();
    });

    // Climate chip from resolved site.
    expect(screen.getByText(/Zone 5A/)).toBeTruthy();

    // KPI cards reflect storey totals verbatim (scoped to each card so the
    // identical footer totals don't create ambiguous matches).
    const sensibleCard = screen.getByText("Sensible Cooling").closest(".lc-card");
    expect(sensibleCard?.textContent).toContain("4,645");
    expect(sensibleCard?.textContent).toContain("tons");

    const supplyCard = screen.getByText("Design Supply Air").closest(".lc-card");
    expect(supplyCard?.textContent).toContain("426");

    const oaCard = screen.getByText("Outside Air (Voz)").closest(".lc-card");
    expect(oaCard?.textContent).toContain("110");
  });

  it("renders one schedule row per space with the correct design driver", async () => {
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("OFFICE 101")).toBeTruthy();
    });
    expect(screen.getByText("WC 102")).toBeTruthy();

    // Office is cooling-load driven; toilet is exhaust-minimum driven. Scope to
    // each row so the legend's "Exhaust min." entry doesn't collide.
    const officeRow = screen.getByText("OFFICE 101").closest("tr");
    expect(officeRow?.textContent).toContain("Cooling load");
    const toiletRow = screen.getByText("WC 102").closest("tr");
    expect(toiletRow?.textContent).toContain("Exhaust min.");
  });

  it("opens a load breakdown when a room is selected", async () => {
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("OFFICE 101")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("OFFICE 101"));

    await waitFor(() => {
      expect(screen.getByText("Design CFM = MAX of")).toBeTruthy();
    });
    // Internal vs envelope split and the assembly breakdown are shown.
    expect(screen.getByText("Envelope conduction")).toBeTruthy();
    expect(screen.getByText("wall-steel-frame")).toBeTruthy();
    // Ventilation parameters.
    expect(screen.getByText("Area rate (Ra)")).toBeTruthy();
  });

  it("surfaces engine diagnostics for the selected room", async () => {
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("WC 102")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("WC 102"));

    await waitFor(() => {
      expect(
        screen.getByText("design CFM is driven by minimum exhaust rate")
      ).toBeTruthy();
    });
  });
});
