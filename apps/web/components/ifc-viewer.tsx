"use client";

import type {
  AirflowType,
  ElementSummary,
  ModelSourceSummary,
  SpaceSummary,
  StoreySummary,
  ViewerMode
} from "@openmep/model-core";
import { useEffect, useMemo, useRef } from "react";
import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";

type ViewerProps = {
  modelId: string;
  sources: ModelSourceSummary[];
  mode: ViewerMode;
  storeys: StoreySummary[];
  selectedStoreyId: string | null;
  selectedSpace: SpaceSummary | null;
  onSelectElement: (globalId: string | null) => void;
  onError: (message: string | null) => void;
};

type ViewerController = {
  components: OBC.Components;
  world: OBC.SimpleWorld<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>;
  fragments: OBC.FragmentsManager;
  views: OBC.Views;
  hider: OBC.Hider;
  modelsBySourceId: Map<string, FRAGS.FragmentsModel>;
  loadedModelIds: string[];
  canvas: HTMLCanvasElement;
  planViewsByStoreyId: Map<string, string>;
  spaceBoundsByGlobalId: Map<string, THREE.Box3>;
  lastIsolatedStoreyId: string | null;
};

const highlightMaterial: FRAGS.MaterialDefinition = {
  color: new THREE.Color("#22D3EE"),
  opacity: 0.95,
  transparent: true,
  renderedFaces: FRAGS.RenderedFaces.TWO,
  preserveOriginalMaterial: true,
  depthTest: true
};

const airflowColors: Record<Exclude<AirflowType, "unknown">, THREE.Color> = {
  supply: new THREE.Color("#579eff"),
  return: new THREE.Color("#ffa348"),
  exhaust: new THREE.Color("#4cc97e"),
  "outside-air": new THREE.Color("#8fdeff")
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function applyAirflowColors(
  controller: ViewerController,
  modelId: string,
  fragmentSources: ModelSourceSummary[]
) {
  const mechanicalSources = fragmentSources.filter(
    (source) => source.discipline === "mechanical"
  );
  for (const model of controller.modelsBySourceId.values()) {
    await model.resetColor(undefined);
  }

  if (mechanicalSources.length === 0) {
    await controller.fragments.core.update(true);
    return;
  }

  const response = await fetch(`/api/models/${modelId}/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      limit: 5000
    })
  });
  if (!response.ok) {
    throw new Error("Unable to fetch airflow classification for 3D styling.");
  }

  const payload = (await response.json()) as { items: ElementSummary[] };
  const mechanicalSourceIds = new Set(mechanicalSources.map((source) => source.sourceId));
  const guidsBySourceAndType = new Map<
    string,
    Map<Exclude<AirflowType, "unknown">, string[]>
  >();

  for (const item of payload.items) {
    if (
      item.discipline !== "mechanical" ||
      item.airflowType === "unknown" ||
      !mechanicalSourceIds.has(item.sourceId)
    ) {
      continue;
    }

    const sourceBuckets = guidsBySourceAndType.get(item.sourceId) ?? new Map();
    const guids = sourceBuckets.get(item.airflowType) ?? [];
    guids.push(item.sourceGlobalId || item.globalId.split(":").pop() || item.globalId);
    sourceBuckets.set(item.airflowType, guids);
    guidsBySourceAndType.set(item.sourceId, sourceBuckets);
  }

  for (const [sourceId, buckets] of guidsBySourceAndType) {
    const model = controller.modelsBySourceId.get(sourceId);
    if (!model) {
      continue;
    }

    for (const [airflowType, guids] of buckets) {
      const localIds = (await model.getLocalIdsByGuids(guids)).filter(
        (localId): localId is number => typeof localId === "number"
      );
      if (localIds.length === 0) {
        continue;
      }
      await model.setColor(localIds, airflowColors[airflowType]);
    }
  }

  await controller.fragments.core.update(true);
}

async function computeSpaceBounds(
  model: FRAGS.FragmentsModel,
  sourceGlobalId: string
): Promise<THREE.Box3 | null> {
  const localIds = (await model.getLocalIdsByGuids([sourceGlobalId])).filter(
    (localId): localId is number => typeof localId === "number"
  );
  if (localIds.length === 0) return null;

  const geometries = await model.getItemsGeometry(localIds);
  const box = new THREE.Box3();
  for (const itemGeoms of geometries) {
    for (const geom of itemGeoms) {
      if (!geom.positions || geom.positions.length === 0) continue;
      const pos = new Float32Array(geom.positions);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.length; i += 3) {
        v.set(pos[i], pos[i + 1], pos[i + 2]);
        v.applyMatrix4(geom.transform);
        box.expandByPoint(v);
      }
    }
  }
  return box.isEmpty() ? null : box;
}

function syncFragmentCameras(controller: ViewerController) {
  for (const [, fragmentModel] of controller.fragments.list) {
    fragmentModel.useCamera(controller.world.camera.three);
  }
}

async function getSpaceBounds(
  controller: ViewerController,
  sourceId: string,
  spaceGlobalId: string
): Promise<THREE.Box3 | null> {
  const cacheKey = `${sourceId}:${spaceGlobalId}`;
  const cached = controller.spaceBoundsByGlobalId.get(cacheKey);
  if (cached) {
    return cached.clone();
  }

  const model = controller.modelsBySourceId.get(sourceId);
  if (!model) {
    return null;
  }

  const box = await computeSpaceBounds(model, spaceGlobalId);
  if (box) {
    controller.spaceBoundsByGlobalId.set(cacheKey, box.clone());
  }
  return box;
}

async function ensurePlanView(
  controller: ViewerController,
  storey: StoreySummary
): Promise<string> {
  const existingViewId = controller.planViewsByStoreyId.get(storey.globalId);
  if (existingViewId) {
    return existingViewId;
  }

  const [view] = await controller.views.createFromIfcStoreys({
    modelIds: controller.loadedModelIds.map(
      (modelId) => new RegExp(`^${escapeRegExp(modelId)}$`)
    ),
    storeyNames: [new RegExp(`^${escapeRegExp(storey.name)}$`)],
    world: controller.world,
    offset: 0.3
  });

  if (!view) {
    throw new Error(`No plan view generated for ${storey.name}.`);
  }

  view.helpersVisible = false;
  controller.planViewsByStoreyId.set(storey.globalId, view.id);
  return view.id;
}

async function enterPlanMode(
  controller: ViewerController,
  storey: StoreySummary
) {
  const viewId = await ensurePlanView(controller, storey);
  await controller.hider.set(true);
  controller.views.open(viewId);
  await controller.world.camera.projection.set("Orthographic");
  controller.world.camera.set("Plan");
  syncFragmentCameras(controller);
  await controller.fragments.core.update(true);
}

async function enterOrbitMode(controller: ViewerController) {
  controller.views.close();
  await controller.world.camera.projection.set("Perspective");
  controller.world.camera.set("Orbit");
  syncFragmentCameras(controller);
  await controller.fragments.core.update(true);
}

export function IfcViewer({
  modelId,
  sources = [],
  mode,
  storeys,
  selectedStoreyId,
  selectedSpace,
  onSelectElement,
  onError
}: ViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ViewerController | null>(null);
  const prevSpaceRef = useRef<string | null>(null);
  const onErrorRef = useRef(onError);
  const onSelectElementRef = useRef(onSelectElement);
  const storeysKey = useMemo(
    () => storeys.map((storey) => `${storey.globalId}:${storey.name}`).join("|"),
    [storeys]
  );
  const fragmentSources = useMemo(
    () =>
      sources.length > 0
        ? sources.filter((source) => Boolean(source.fragmentsUrl))
        : [
            {
              modelId,
              sourceId: "architecture",
              discipline: "architecture",
              name: "Architecture",
              status: "ready",
              schema: null,
              sourceKey: "",
              fragmentsKey: null,
              indexKey: null,
              createdAt: "",
              updatedAt: "",
              counts: {
                storeys: 0,
                spaces: 0,
                elements: 0
              },
              fragmentsUrl: `/api/models/${modelId}/fragments`,
              errorMessage: null
            } satisfies ModelSourceSummary
          ],
    [modelId, sources]
  );
  const selectedStorey = useMemo(
    () =>
      selectedStoreyId
        ? storeys.find((storey) => storey.globalId === selectedStoreyId) ?? null
        : null,
    [selectedStoreyId, storeys]
  );

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    onSelectElementRef.current = onSelectElement;
  }, [onSelectElement]);

  useEffect(() => {
    let cancelled = false;
    let clickHandler: ((event: MouseEvent) => Promise<void>) | null = null;

    const setup = async () => {
      if (!containerRef.current) {
        return;
      }

      try {
        const components = new OBC.Components();
        const worlds = components.get(OBC.Worlds);
        const world = worlds.create<
          OBC.SimpleScene,
          OBC.OrthoPerspectiveCamera,
          OBC.SimpleRenderer
        >();

        world.scene = new OBC.SimpleScene(components);
        world.scene.setup();
        world.scene.three.background = new THREE.Color("#0A0F1C");
        world.renderer = new OBC.SimpleRenderer(components, containerRef.current);
        world.camera = new OBC.OrthoPerspectiveCamera(components);

        const grid = components.get(OBC.Grids).create(world);
        grid.visible = false;

        components.init();
        await world.camera.controls.setLookAt(50, 45, 50, 0, 0, 0);

        const fragments = components.get(OBC.FragmentsManager);
        fragments.init("/api/runtime/fragments-worker");
        const views = components.get(OBC.Views);
        views.world = world;
        const hider = components.get(OBC.Hider);

        world.camera.controls.addEventListener("rest", () => {
          void fragments.core.update(true);
        });

        world.onCameraChanged.add((camera) => {
          for (const [, fragmentModel] of fragments.list) {
            fragmentModel.useCamera(camera.three);
          }
          void fragments.core.update(true);
        });

        fragments.list.onItemSet.add(({ value }) => {
          value.useCamera(world.camera.three);
          world.scene.three.add(value.object);
          void fragments.core.update(true);
        });

        const canvas = containerRef.current.querySelector("canvas");
        if (!(canvas instanceof HTMLCanvasElement)) {
          throw new Error("Viewer canvas was not created.");
        }

        const modelsBySourceId = new Map<string, FRAGS.FragmentsModel>();
        const loadedModelIds: string[] = [];
        for (const source of fragmentSources) {
          if (!source.fragmentsUrl) {
            continue;
          }

          const response = await fetch(source.fragmentsUrl, {
            cache: "no-store"
          });
          if (!response.ok) {
            throw new Error(`Unable to fetch Fragments payload for ${source.name}.`);
          }

          const buffer = await response.arrayBuffer();
          const fragmentsModelId = `${modelId}:${source.sourceId}`;
          const model = await fragments.core.load(new Uint8Array(buffer), {
            modelId: fragmentsModelId,
            camera: world.camera.three,
            raw: true
          });
          Object.assign(model, { __sourceId: source.sourceId });
          modelsBySourceId.set(source.sourceId, model);
          loadedModelIds.push(fragmentsModelId);
        }

        if (modelsBySourceId.size === 0) {
          throw new Error(`Unable to fetch Fragments payload for model ${modelId}.`);
        }

        if (cancelled) {
          components.dispose();
          return;
        }

        const controller: ViewerController = {
          components,
          world,
          fragments,
          views,
          hider,
          modelsBySourceId,
          loadedModelIds,
          canvas,
          planViewsByStoreyId: new Map(),
          spaceBoundsByGlobalId: new Map(),
          lastIsolatedStoreyId: null
        };
        controllerRef.current = controller;

        await applyAirflowColors(controller, modelId, fragmentSources);

        clickHandler = async (event: MouseEvent) => {
          const controller = controllerRef.current;
          if (!controller) {
            return;
          }

          const rect = controller.canvas.getBoundingClientRect();
          const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
          );

          const hit = await controller.fragments.raycast({
            camera: controller.world.camera.three,
            mouse,
            dom: controller.canvas
          });

          if (!hit) {
            void onSelectElementRef.current(null);
            return;
          }

          const [guid] = await hit.fragments.getGuidsByLocalIds([hit.localId]);
          const sourceId =
            (hit.fragments as unknown as { __sourceId?: string }).__sourceId ?? "architecture";
          void onSelectElementRef.current(
            guid ? `${sourceId}:${guid}` : null
          );
        };

        canvas.addEventListener("click", clickHandler);
        await fragments.core.update(true);
        onErrorRef.current(null);
      } catch (error) {
        onErrorRef.current(
          error instanceof Error ? error.message : "Unable to initialize viewer."
        );
      }
    };

    void setup();
    return () => {
      cancelled = true;
      const controller = controllerRef.current;
      if (controller) {
        if (clickHandler) {
          controller.canvas.removeEventListener("click", clickHandler);
        }
        controller.components.dispose();
        controllerRef.current = null;
      }
    };
  }, [modelId, fragmentSources]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || storeys.length === 0) {
      return;
    }

    void (async () => {
      try {
        for (const storey of storeys) {
          await ensurePlanView(controller, storey);
        }
      } catch (error) {
        onErrorRef.current(
          error instanceof Error ? error.message : "Unable to prepare plan views."
        );
      }
    })();
  }, [storeysKey]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) {
      return;
    }

    void (async () => {
      try {
        if (!selectedStorey) {
          return;
        }

        if (mode !== "3d") {
          await controller.hider.set(true);
          controller.lastIsolatedStoreyId = null;
          await controller.fragments.core.update(true);
          return;
        }

        if (controller.lastIsolatedStoreyId === selectedStorey.globalId) {
          return;
        }

        const response = await fetch(`/api/models/${modelId}/query`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            storeyGlobalIds: [selectedStorey.globalId],
            limit: 5000
          })
        });
        if (!response.ok) {
          throw new Error(`Unable to query elements for ${selectedStorey.name}.`);
        }
        const payload = (await response.json()) as { items: { globalId: string }[] };
        const guids = payload.items.map((item) => item.globalId.split(":").pop() ?? item.globalId);
        const modelIdMap = await controller.fragments.guidsToModelIdMap(guids);
        await controller.hider.isolate(modelIdMap);
        controller.lastIsolatedStoreyId = selectedStorey.globalId;
        await controller.fragments.core.update(true);
      } catch (error) {
        onErrorRef.current(
          error instanceof Error ? error.message : "Unable to apply storey filter."
        );
      }
    })();
  }, [mode, modelId, selectedStorey?.globalId]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) {
      return;
    }

    const spaceGlobalId = selectedSpace?.globalId ?? null;
    const isFirstRun = prevSpaceRef.current === null && spaceGlobalId !== null;
    const didChange = prevSpaceRef.current !== spaceGlobalId;
    prevSpaceRef.current = spaceGlobalId;

    void (async () => {
      try {
        await controller.fragments.resetHighlight();
        if (!selectedSpace) {
          await controller.fragments.core.update(true);
          return;
        }
        const modelIdMap = await controller.fragments.guidsToModelIdMap([
          selectedSpace.sourceGlobalId || selectedSpace.globalId
        ]);
        await controller.fragments.highlight(highlightMaterial, modelIdMap);

        if (mode === "3d" && didChange && !isFirstRun) {
          const box = await getSpaceBounds(
            controller,
            selectedSpace.sourceId,
            selectedSpace.sourceGlobalId || selectedSpace.globalId
          );
          if (box) {
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const distance = Math.max(size.x, size.y, size.z) * 1.5 + 10;
            await controller.world.camera.controls.setLookAt(
              center.x + distance * 0.6,
              center.y + distance * 0.6,
              center.z + distance * 0.4,
              center.x,
              center.y,
              center.z,
              true
            );
          }
        }
        await controller.fragments.core.update(true);
      } catch (error) {
        onErrorRef.current(
          error instanceof Error ? error.message : "Unable to highlight room."
        );
      }
    })();
  }, [mode, selectedSpace?.globalId]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) {
      return;
    }

    void (async () => {
      try {
        if (mode === "2d" && selectedStorey) {
          await enterPlanMode(controller, selectedStorey);
        } else {
          await enterOrbitMode(controller);
        }
      } catch (error) {
        onErrorRef.current(
          error instanceof Error ? error.message : "Unable to switch view mode."
        );
      }
    })();
  }, [mode, selectedStorey?.globalId]);

  return (
    <div className="viewer-stage">
      <div className="viewer-canvas" ref={containerRef} />
    </div>
  );
}
