// @vitest-environment jsdom

import type { ModelSourceSummary, SpaceSummary, StoreySummary } from "@openmep/model-core";
import React from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let loadMock: ReturnType<typeof vi.fn>;
let onItemSetHandler: ((event: { value: { useCamera: () => void; object: object } }) => void) | null;

vi.mock("@thatopen/fragments", () => ({
  RenderedFaces: {
    TWO: 1
  }
}));

vi.mock("@thatopen/components", () => {
  class Components {
    init() {}
    dispose() {}
    get(Component: new (...args: any[]) => unknown) {
      return new Component(this);
    }
  }

  class Worlds {
    create() {
      return {
        scene: null,
        renderer: null,
        camera: null,
        onCameraChanged: {
          add: vi.fn()
        }
      };
    }
  }

  class SimpleScene {
    three = {
      background: null,
      add: vi.fn()
    };

    constructor(_components: unknown) {}

    setup() {}
  }

  class SimpleRenderer {
    constructor(_components: unknown, container: HTMLDivElement) {
      const canvas = document.createElement("canvas");
      container.appendChild(canvas);
    }
  }

  class OrthoPerspectiveCamera {
    three = {};
    projection = {
      set: vi.fn(async () => {})
    };
    controls = {
      setLookAt: vi.fn(async () => {}),
      addEventListener: vi.fn()
    };

    constructor(_components: unknown) {}

    set = vi.fn();
  }

  class Grids {
    create() {
      return { visible: true };
    }
  }

  class FragmentsManager {
    core = {
      load: loadMock,
      update: vi.fn(async () => {})
    };
    list = {
      onItemSet: {
        add: vi.fn((handler: typeof onItemSetHandler) => {
          onItemSetHandler = handler;
        })
      },
      [Symbol.iterator]: function* () {
        yield [
          "model-1",
          {
            useCamera: vi.fn()
          }
        ];
      }
    };

    constructor(_components: unknown) {}

    init = vi.fn();
    raycast = vi.fn(async () => undefined);
    resetHighlight = vi.fn(async () => {});
    highlight = vi.fn(async () => {});
    guidsToModelIdMap = vi.fn(async () => ({}));
  }

  class Views {
    world = null;
    constructor(_components: unknown) {}
    createFromIfcStoreys = vi.fn(async () => []);
    open = vi.fn();
    close = vi.fn();
  }

  class Hider {
    constructor(_components: unknown) {}
    set = vi.fn(async () => {});
    isolate = vi.fn(async () => {});
  }

  return {
    Components,
    Worlds,
    SimpleScene,
    SimpleRenderer,
    OrthoPerspectiveCamera,
    Grids,
    FragmentsManager,
    Views,
    Hider
  };
});

import { IfcViewer } from "./ifc-viewer";

const storeys: StoreySummary[] = [
  {
    modelId: "model-1",
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

const selectedSpace: SpaceSummary | null = null;

function mockFragmentsResponse() {
  return Promise.resolve({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8)
  } as Response);
}

describe("IfcViewer", () => {
  beforeEach(() => {
    onItemSetHandler = null;
    loadMock = vi.fn(async () => {
      const model = {
        useCamera: vi.fn(),
        object: {},
        getGuidsByLocalIds: vi.fn(async () => []),
        getLocalIdsByGuids: vi.fn(async () => []),
        getItemsGeometry: vi.fn(async () => []),
        setColor: vi.fn(async () => {}),
        resetColor: vi.fn(async () => {})
      };
      onItemSetHandler?.({ value: model });
      return model;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not refetch fragments when rerendered with the same model id", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/models/model-1/fragments")) {
        return mockFragmentsResponse();
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstOnError = vi.fn();
    const firstOnSelectElement = vi.fn();
    const { rerender } = render(
      React.createElement(IfcViewer, {
        mode: "3d",
        modelId: "model-1",
        sources: [],
        onError: firstOnError,
        onSelectElement: firstOnSelectElement,
        selectedSpace,
        selectedStoreyId: null,
        storeys
      })
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    rerender(
      React.createElement(IfcViewer, {
        mode: "3d",
        modelId: "model-1",
        sources: [],
        onError: vi.fn(),
        onSelectElement: vi.fn(),
        selectedSpace,
        selectedStoreyId: null,
        storeys: [...storeys]
      })
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("applies airflow colors to classified mechanical elements", async () => {
    const createdModels: Array<{
      setColor: ReturnType<typeof vi.fn>;
      resetColor: ReturnType<typeof vi.fn>;
    }> = [];
    loadMock = vi.fn(async () => {
      const model = {
        useCamera: vi.fn(),
        object: {},
        getGuidsByLocalIds: vi.fn(async () => []),
        getLocalIdsByGuids: vi.fn(async (guids: string[]) => guids.map((_guid, index) => index + 1)),
        getItemsGeometry: vi.fn(async () => []),
        setColor: vi.fn(async () => {}),
        resetColor: vi.fn(async () => {})
      };
      createdModels.push(model);
      onItemSetHandler?.({ value: model });
      return model;
    });

    const sources: ModelSourceSummary[] = [
      {
        modelId: "model-1",
        sourceId: "architecture",
        discipline: "architecture",
        name: "ARCH",
        status: "ready",
        schema: "IFC2X3",
        sourceKey: "arch.ifc",
        fragmentsKey: "arch.frag",
        indexKey: "arch.json",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        counts: { storeys: 1, spaces: 1, elements: 2 },
        fragmentsUrl: "/api/models/model-1/sources/architecture/fragments",
        errorMessage: null
      },
      {
        modelId: "model-1",
        sourceId: "mechanical",
        discipline: "mechanical",
        name: "MECH",
        status: "ready",
        schema: "IFC2X3",
        sourceKey: "mech.ifc",
        fragmentsKey: "mech.frag",
        indexKey: "mech.json",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        counts: { storeys: 1, spaces: 0, elements: 2 },
        fragmentsUrl: "/api/models/model-1/sources/mechanical/fragments",
        errorMessage: null
      }
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/models/model-1/sources/architecture/fragments")) {
        return mockFragmentsResponse();
      }
      if (url.endsWith("/api/models/model-1/sources/mechanical/fragments")) {
        return mockFragmentsResponse();
      }
      if (url.endsWith("/api/models/model-1/query") && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            total: 2,
            items: [
              {
                modelId: "model-1",
                sourceId: "mechanical",
                discipline: "mechanical",
                expressId: 1,
                sourceGlobalId: "duct-1",
                globalId: "mechanical:duct-1",
                compositeGlobalId: "mechanical:duct-1",
                ifcClass: "IFCFLOWSEGMENT",
                name: "Duct 1",
                longName: null,
                description: null,
                objectType: null,
                tag: null,
                storeyGlobalId: "storey-1",
                spaceGlobalId: null,
                placement: null,
                airflowType: "supply",
                systemAssignments: [],
                properties: {}
              },
              {
                modelId: "model-1",
                sourceId: "mechanical",
                discipline: "mechanical",
                expressId: 2,
                sourceGlobalId: "duct-2",
                globalId: "mechanical:duct-2",
                compositeGlobalId: "mechanical:duct-2",
                ifcClass: "IFCFLOWSEGMENT",
                name: "Duct 2",
                longName: null,
                description: null,
                objectType: null,
                tag: null,
                storeyGlobalId: "storey-1",
                spaceGlobalId: null,
                placement: null,
                airflowType: "return",
                systemAssignments: [],
                properties: {}
              }
            ]
          })
        } as Response);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(IfcViewer, {
        mode: "3d",
        modelId: "model-1",
        onError: vi.fn(),
        onSelectElement: vi.fn(),
        selectedSpace,
        selectedStoreyId: null,
        sources,
        storeys
      })
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/models/model-1/query",
        expect.objectContaining({
          method: "POST"
        })
      );
      expect(createdModels).toHaveLength(2);
      expect(createdModels[1].setColor).toHaveBeenCalledTimes(2);
    });
  });
});
