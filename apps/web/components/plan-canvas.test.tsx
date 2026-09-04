// @vitest-environment jsdom

import type { PlanStorey } from "@openmep/model-core";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlanCanvas } from "./plan-canvas";

const storey: PlanStorey = {
  modelId: "model-1",
  planVersion: 5,
  globalId: "storey-1",
  name: "Level 1",
  longName: null,
  elevation: 0,
  sortOrder: 0,
  units: "foot",
  origin3D: [0, 0, 0],
  uAxis3D: [1, 0, 0],
  vAxis3D: [0, 1, 0],
  upAxis3D: [0, 0, 1],
  worldBounds3D: {
    min: [0, 0, 0],
    max: [100, 12, 100]
  },
  bounds: {
    min: [0, 0],
    max: [100, 100]
  },
  contextBounds: {
    min: [0, 0],
    max: [100, 100]
  },
  focusBounds: {
    min: [0, 0],
    max: [100, 100]
  },
  architecture: {
    primitives: [],
    spaces: []
  },
  mechanicalVisual2D: [],
  mechanicalEdit2D: [
    {
      id: "terminal-1",
      editKind: "node",
      elementRef: "element-1",
      visualRef: "visual-1",
      kind: "mech-terminal",
      position: [40, 40],
      size: [4, 4],
      rotation: 0,
      airflowType: "supply",
      connectedItemIds: [],
      spaceGlobalId: null,
      spaceDesignCfm: null,
      requiredCfm: null
    }
  ],
  loads: {
    modelId: "model-1",
    storeyGlobalId: "storey-1",
    planVersion: 5,
    spaces: [],
    totals: {
      designCfm: 0,
      ventilationCfm: 0,
      sensibleLoadBtuH: 0,
      envelopeBtuH: 0, solarBtuH: 0,
      spaceCount: 0
    },
    climate: null
  }
};

describe("PlanCanvas", () => {
  afterEach(() => {
    cleanup();
  });

  it("preserves manual zoom when capture polling replaces storey data", async () => {
    const { rerender } = render(
      <PlanCanvas
        onSelect={vi.fn()}
        selectedGlobalId={null}
        selectedSpaceId={null}
        showArchitecture
        showMechanical
        showMechanicalEditOverlay
        storey={storey}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    const canvas = screen.getByTestId("plan-canvas");
    expect(document.querySelector('[data-edit-id="terminal-1"] rect')?.getAttribute("width")).toBe("4");
    const initialViewBox = canvas.getAttribute("data-view-box");
    fireEvent.wheel(canvas, { clientX: 50, clientY: 50, deltaY: -100 });
    const zoomedViewBox = canvas.getAttribute("data-view-box");
    expect(zoomedViewBox).not.toBe(initialViewBox);

    for (let index = 0; index < 20; index += 1) {
      fireEvent.wheel(canvas, { clientX: 50, clientY: 50, deltaY: -100 });
    }
    const deeplyZoomedWidth = Number(canvas.getAttribute("data-view-box")?.split(" ")[2]);
    expect(deeplyZoomedWidth).toBeLessThan(10);

    const terminal = storey.mechanicalEdit2D[0];
    if (terminal.editKind !== "node") {
      throw new Error("Expected test fixture to use a node edit item.");
    }

    rerender(
      <PlanCanvas
        onSelect={vi.fn()}
        selectedGlobalId={null}
        selectedSpaceId={null}
        showArchitecture
        showMechanical
        showMechanicalEditOverlay
        storey={{
          ...storey,
          mechanicalEdit2D: [
            {
              ...terminal,
              position: [40, 60]
            }
          ]
        }}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(Number(canvas.getAttribute("data-view-box")?.split(" ")[2])).toBe(deeplyZoomedWidth);
  });

  it("moves rich visual geometry with matching node edits", async () => {
    render(
      <PlanCanvas
        onSelect={vi.fn()}
        selectedGlobalId={null}
        selectedSpaceId={null}
        showArchitecture
        showMechanical
        showMechanicalEditOverlay
        storey={{
          ...storey,
          mechanicalVisual2D: [
            {
              modelId: "model-1",
              sourceId: "mechanical",
              discipline: "mechanical",
              sourceGlobalId: "visual-1",
              globalId: "visual-1",
              compositeGlobalId: "visual-1",
              backingElementId: "element-1",
              expressId: 1,
              ifcClass: "IFCFLOWTERMINAL",
              storeyGlobalId: "storey-1",
              geometryType: "visual",
              kind: "mech-terminal",
              polygons: [{ outer: [[8, 9], [12, 9], [12, 11], [8, 11]], holes: [] }],
              bounds: { min: [8, 9], max: [12, 11] },
              presentationCategory: "building",
              airflowType: "supply",
              sourceName: "Linear Slot Diffuser",
              diagnostics: [],
              anchor: [10, 10],
              rotation: 0,
              connectedItemIds: []
            }
          ]
        }}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    const movedVisual = document.querySelector('[data-visual-id="visual-1"]')?.parentElement;
    expect(movedVisual?.getAttribute("transform")).toBe("translate(30 30)");
    expect(document.querySelector('[data-edit-id="terminal-1"] rect')).toBeNull();
  });
});
