"use client";

import type {
  Bounds2D,
  MechanicalEditItem,
  MechanicalVisualItem,
  PlanPolygon,
  PlanPrimitive,
  PlanSpace,
  PlanStorey,
  SpaceLoad
} from "@mep/model-core";
import type { PointerEventHandler, WheelEventHandler } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

type SelectedItem = {
  globalId: string;
  kind: string;
};

type ViewBox = {
  minX: number;
  minY: number;
  width: number;
  height: number;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: ViewBox;
};

type MechanicalNodeEditItem = Extract<MechanicalEditItem, { editKind: "node" }>;

type Props = {
  showArchitecture: boolean;
  showMechanicalEditOverlay: boolean;
  showMechanical: boolean;
  storey: PlanStorey | null;
  selectedGlobalId: string | null;
  selectedSpaceId: string | null;
  onSelect: (item: SelectedItem) => void;
};

const OVERVIEW_PADDING = 0.06;
const ROOM_PADDING = 0.24;
const CONTEXT_PADDING = 0.12;
const LABEL_ZOOM_THRESHOLD = 1.35;
const DOOR_ZOOM_THRESHOLD = 1.5;

function polygonPath(polygon: PlanPolygon) {
  const segments = [polygon.outer, ...polygon.holes].map((ring) => {
    const [first, ...rest] = ring;
    return `M ${first[0]} ${first[1]} ${rest.map(([x, y]) => `L ${x} ${y}`).join(" ")} Z`;
  });
  return segments.join(" ");
}

function primitivePath(primitive: PlanPrimitive | PlanSpace) {
  return primitive.polygons.map(polygonPath).join(" ");
}

function linearPath(item: { path: ReadonlyArray<readonly [number, number]> }) {
  const [first, ...rest] = item.path;
  return `M ${first[0]} ${first[1]} ${rest.map(([x, y]) => `L ${x} ${y}`).join(" ")}`;
}

function visualPath(item: MechanicalVisualItem) {
  return item.polygons.map(polygonPath).join(" ");
}

function boundsCenter(bounds: Bounds2D): readonly [number, number] {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2
  ];
}

function movedVisualTransform(
  visualItem: MechanicalVisualItem,
  editItem: MechanicalNodeEditItem | undefined
) {
  if (!editItem) {
    return undefined;
  }

  const [centerX, centerY] = boundsCenter(visualItem.bounds);
  const deltaX = editItem.position[0] - centerX;
  const deltaY = editItem.position[1] - centerY;
  return `translate(${deltaX} ${deltaY})`;
}

function expandBounds(bounds: Bounds2D, ratio: number): ViewBox {
  const width = Math.max(bounds.max[0] - bounds.min[0], 1);
  const height = Math.max(bounds.max[1] - bounds.min[1], 1);
  const padding = Math.max(width, height) * ratio;
  return {
    minX: bounds.min[0] - padding,
    minY: bounds.min[1] - padding,
    width: width + padding * 2,
    height: height + padding * 2
  };
}

function lerp(start: number, end: number, t: number) {
  return start + (end - start) * t;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatViewBox(viewBox: ViewBox) {
  return `${viewBox.minX} ${viewBox.minY} ${viewBox.width} ${viewBox.height}`;
}

function flipY(storey: PlanStorey, y: number) {
  return storey.contextBounds.min[1] + storey.contextBounds.max[1] - y;
}

function shouldRenderLabel(
  space: PlanSpace,
  selectedSpaceId: string | null,
  viewBox: ViewBox,
  labelsEnabled: boolean
) {
  if (space.globalId === selectedSpaceId) {
    return true;
  }

  if (!labelsEnabled) {
    return false;
  }

  const width = space.bounds.max[0] - space.bounds.min[0];
  const height = space.bounds.max[1] - space.bounds.min[1];
  const area = space.area ?? width * height;
  const widthRatio = width / Math.max(viewBox.width, 1);
  const heightRatio = height / Math.max(viewBox.height, 1);

  return area >= 40 && widthRatio >= 0.11 && heightRatio >= 0.065;
}

function primitiveClasses(
  primitive: PlanPrimitive | PlanSpace | MechanicalVisualItem | MechanicalEditItem,
  selectedGlobalId: string | null,
  selectedSpaceId: string | null
) {
  const classNames = ["plan-primitive", primitive.kind];
  if ("presentationCategory" in primitive) {
    classNames.push(primitive.presentationCategory);
  }
  if ("editKind" in primitive) {
    classNames.push(`edit-${primitive.editKind}`);
  }
  if ("airflowType" in primitive && primitive.airflowType !== "unknown") {
    classNames.push(`airflow-${primitive.airflowType}`);
  }

  const selectionId =
    "elementRef" in primitive
      ? primitive.elementRef
      : "backingElementId" in primitive
        ? primitive.backingElementId
        : primitive.globalId;
  if (selectionId === selectedGlobalId) {
    classNames.push("selected");
  }

  if (
    primitive.kind === "space" &&
    selectedSpaceId &&
    primitive.globalId !== selectedSpaceId
  ) {
    classNames.push("muted");
  }

  return classNames.join(" ");
}

function normalizeViewBox(
  candidate: ViewBox,
  storey: PlanStorey,
  defaultViewBox: ViewBox
) {
  const context = expandBounds(storey.contextBounds, CONTEXT_PADDING);
  const minWidth = Math.max(defaultViewBox.width * 0.035, 1);
  const minHeight = Math.max(defaultViewBox.height * 0.035, 1);
  const width = clamp(candidate.width, minWidth, context.width);
  const height = clamp(candidate.height, minHeight, context.height);
  const maxMinX = context.minX + context.width - width;
  const maxMinY = context.minY + context.height - height;

  return {
    minX: clamp(candidate.minX, context.minX, maxMinX),
    minY: clamp(candidate.minY, context.minY, maxMinY),
    width,
    height
  };
}

function fontSizeForView(viewBox: ViewBox) {
  return clamp(viewBox.width * 0.018, 0.85, 3.2);
}

export function PlanCanvas({
  showArchitecture,
  showMechanicalEditOverlay,
  showMechanical,
  storey,
  selectedGlobalId,
  selectedSpaceId,
  onSelect
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const viewScopeRef = useRef<string | null>(null);
  const [viewBox, setViewBox] = useState<ViewBox | null>(null);

  const viewScopeKey = storey
    ? [
        storey.globalId,
        storey.focusBounds.min[0],
        storey.focusBounds.min[1],
        storey.focusBounds.max[0],
        storey.focusBounds.max[1],
        storey.contextBounds.min[0],
        storey.contextBounds.min[1],
        storey.contextBounds.max[0],
        storey.contextBounds.max[1]
      ].join(":")
    : null;

  const defaultViewBox = useMemo(
    () => (storey ? expandBounds(storey.focusBounds, OVERVIEW_PADDING) : null),
    [viewScopeKey]
  );
  const selectedSpaceViewKey =
    storey && selectedSpaceId
      ? (() => {
          const space =
            storey.architecture.spaces.find((candidate) => candidate.globalId === selectedSpaceId) ??
            null;
          return space
            ? [
                space.globalId,
                space.bounds.min[0],
                space.bounds.min[1],
                space.bounds.max[0],
                space.bounds.max[1]
              ].join(":")
            : null;
        })()
      : null;

  useEffect(() => {
    if (!defaultViewBox) {
      setViewBox(null);
      viewScopeRef.current = null;
      return;
    }

    if (viewScopeRef.current !== viewScopeKey) {
      viewScopeRef.current = viewScopeKey;
      setViewBox(defaultViewBox);
    }
  }, [defaultViewBox, viewScopeKey]);

  useEffect(() => {
    if (!storey || !defaultViewBox) {
      return;
    }

    const selectedSpace =
      storey.architecture.spaces.find((space) => space.globalId === selectedSpaceId) ?? null;
    const target = selectedSpace
      ? expandBounds(selectedSpace.bounds, ROOM_PADDING)
      : defaultViewBox;
    let animationFrame = 0;

    setViewBox((current) => {
      const origin = current ?? target;
      if (
        origin.minX === target.minX &&
        origin.minY === target.minY &&
        origin.width === target.width &&
        origin.height === target.height
      ) {
        return origin;
      }

      const start = performance.now();
      const animate = (timestamp: number) => {
        const progress = Math.min((timestamp - start) / 220, 1);
        const eased = 1 - (1 - progress) * (1 - progress);
        setViewBox(
          normalizeViewBox(
            {
              minX: lerp(origin.minX, target.minX, eased),
              minY: lerp(origin.minY, target.minY, eased),
              width: lerp(origin.width, target.width, eased),
              height: lerp(origin.height, target.height, eased)
            },
            storey,
            defaultViewBox
          )
        );

        if (progress < 1) {
          animationFrame = window.requestAnimationFrame(animate);
        }
      };

      animationFrame = window.requestAnimationFrame(animate);
      return origin;
    });

    return () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [defaultViewBox, selectedSpaceId, selectedSpaceViewKey, viewScopeKey]);

  if (!storey || !viewBox || !defaultViewBox) {
    return <div className="empty-state">Plan view unavailable for this storey.</div>;
  }

  const visiblePrimitives = showArchitecture ? storey.architecture.primitives : [];
  const mechanicalVisualItems = showMechanical ? storey.mechanicalVisual2D : [];
  const mechanicalEditItems =
    showMechanical && showMechanicalEditOverlay ? storey.mechanicalEdit2D : [];
  const visualItemIds = new Set(
    mechanicalVisualItems.flatMap((item) => [item.globalId, item.backingElementId])
  );
  const nodeEditsByVisualIdentity = new Map<string, MechanicalNodeEditItem>();
  for (const item of mechanicalEditItems) {
    if (item.editKind !== "node") {
      continue;
    }
    nodeEditsByVisualIdentity.set(item.visualRef, item);
    nodeEditsByVisualIdentity.set(item.elementRef, item);
  }
  const wallsAndColumns = visiblePrimitives.filter(
    (primitive) => primitive.kind === "wall" || primitive.kind === "column"
  );
  const doors = visiblePrimitives.filter((primitive) => primitive.kind === "door-opening");
  const zoomFactor = Math.max(
    defaultViewBox.width / Math.max(viewBox.width, 1),
    defaultViewBox.height / Math.max(viewBox.height, 1)
  );
  const renderDoors = zoomFactor >= DOOR_ZOOM_THRESHOLD;
  const allSpaces = storey.architecture.spaces;
  const selectedSpace =
    allSpaces.find((space) => space.globalId === selectedSpaceId) ?? null;
  const visibleSpaceOverlays = selectedSpace ? [selectedSpace] : [];
  const labelSpaces = storey.architecture.spaces.filter((space) =>
    showArchitecture &&
    shouldRenderLabel(space, selectedSpaceId, viewBox, zoomFactor >= LABEL_ZOOM_THRESHOLD)
  );
  const mirroredPlane = `translate(0 ${storey.contextBounds.min[1] + storey.contextBounds.max[1]}) scale(1 -1)`;
  const primaryFontSize = fontSizeForView(viewBox);
  const secondaryFontSize = primaryFontSize * 0.78;
  const loadsBySpaceId = new Map<string, SpaceLoad>(
    storey.loads.spaces.map((load) => [load.spaceGlobalId, load])
  );

  const onWheel: WheelEventHandler<SVGSVGElement> = (event) => {
    event.preventDefault();

    const rect = svgRef.current?.getBoundingClientRect();
    const width = rect?.width && rect.width > 0 ? rect.width : 1;
    const height = rect?.height && rect.height > 0 ? rect.height : 1;
    const offsetX = rect ? (event.clientX - rect.left) / width : 0.5;
    const offsetY = rect ? (event.clientY - rect.top) / height : 0.5;
    const zoomStep = event.deltaY < 0 ? 0.88 : 1.14;
    const nextWidth = viewBox.width * zoomStep;
    const nextHeight = viewBox.height * zoomStep;
    const anchorX = viewBox.minX + viewBox.width * offsetX;
    const anchorY = viewBox.minY + viewBox.height * offsetY;

    setViewBox(
      normalizeViewBox(
        {
          minX: anchorX - nextWidth * offsetX,
          minY: anchorY - nextHeight * offsetY,
          width: nextWidth,
          height: nextHeight
        },
        storey,
        defaultViewBox
      )
    );
  };

  const onPointerDown: PointerEventHandler<SVGSVGElement> = (event) => {
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: viewBox
    };
    if (svgRef.current?.setPointerCapture) {
      svgRef.current.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove: PointerEventHandler<SVGSVGElement> = (event) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) {
      return;
    }

    const rect = svgRef.current?.getBoundingClientRect();
    const width = rect?.width && rect.width > 0 ? rect.width : 1;
    const height = rect?.height && rect.height > 0 ? rect.height : 1;
    const deltaX = ((event.clientX - dragRef.current.startX) / width) * dragRef.current.origin.width;
    const deltaY = ((event.clientY - dragRef.current.startY) / height) * dragRef.current.origin.height;

    setViewBox(
      normalizeViewBox(
        {
          minX: dragRef.current.origin.minX - deltaX,
          minY: dragRef.current.origin.minY - deltaY,
          width: dragRef.current.origin.width,
          height: dragRef.current.origin.height
        },
        storey,
        defaultViewBox
      )
    );
  };

  const onPointerUp: PointerEventHandler<SVGSVGElement> = (event) => {
    if (svgRef.current?.releasePointerCapture) {
      svgRef.current.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  return (
    <div className="plan-stage">
      <svg
        aria-label={`${storey.name} plan`}
        className="plan-canvas"
        data-testid="plan-canvas"
        data-view-box={formatViewBox(viewBox)}
        ref={svgRef}
        role="img"
        viewBox={formatViewBox(viewBox)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
      >
        <g className="plan-layer geometry" transform={mirroredPlane}>
          <g className="plan-layer space-hitareas">
            {allSpaces.map((space) => (
              <path
                aria-label={`space-hit ${space.globalId}`}
                className="plan-space-hitarea"
                d={primitivePath(space)}
                fillRule="evenodd"
                key={`hit-${space.globalId}`}
                onClick={() => onSelect({ globalId: space.globalId, kind: space.kind })}
              />
            ))}
          </g>

          <g className="plan-layer spaces">
            {visibleSpaceOverlays.map((space) => (
              <path
                aria-label={`${space.kind} ${space.globalId}`}
                className={primitiveClasses(space, selectedGlobalId, selectedSpaceId)}
                d={primitivePath(space)}
                data-category={space.presentationCategory}
                fillRule="evenodd"
                key={`${space.kind}-${space.globalId}`}
                onClick={() => onSelect({ globalId: space.globalId, kind: space.kind })}
              />
            ))}
          </g>

          <g className="plan-layer structure">
            {wallsAndColumns.map((primitive) => (
              <path
                aria-label={`${primitive.kind} ${primitive.globalId}`}
                className={primitiveClasses(primitive, selectedGlobalId, selectedSpaceId)}
                d={primitivePath(primitive)}
                data-category={primitive.presentationCategory}
                fillRule="evenodd"
                key={`${primitive.kind}-${primitive.globalId}`}
                onClick={() => onSelect({ globalId: primitive.globalId, kind: primitive.kind })}
              />
            ))}
          </g>

          {renderDoors ? (
            <g className="plan-layer openings">
              {doors.map((primitive) => (
                <path
                  aria-label={`${primitive.kind} ${primitive.globalId}`}
                  className={primitiveClasses(primitive, selectedGlobalId, selectedSpaceId)}
                  d={primitivePath(primitive)}
                  data-category={primitive.presentationCategory}
                  fillRule="evenodd"
                  key={`${primitive.kind}-${primitive.globalId}`}
                  onClick={() => onSelect({ globalId: primitive.globalId, kind: primitive.kind })}
                />
              ))}
            </g>
          ) : null}

          <g className="plan-layer mechanical visual">
            {mechanicalVisualItems.map((item) => {
              const editItem =
                nodeEditsByVisualIdentity.get(item.globalId) ??
                nodeEditsByVisualIdentity.get(item.backingElementId);
              return (
                <g
                  data-edit-id={editItem?.id}
                  data-position={editItem?.position.join(",")}
                  key={item.globalId}
                  transform={movedVisualTransform(item, editItem)}
                >
                  <path
                    aria-label={`${item.kind} ${item.backingElementId}`}
                    className={primitiveClasses(editItem ?? item, selectedGlobalId, selectedSpaceId)}
                    d={visualPath(item)}
                    data-category={item.presentationCategory}
                    data-visual-id={item.globalId}
                    fillRule="evenodd"
                    onClick={() => onSelect({ globalId: item.backingElementId, kind: item.kind })}
                  />
                </g>
              );
            })}
          </g>

          <g className="plan-layer mechanical edit">
            {mechanicalEditItems.map((item) => {
              if (item.editKind === "edge") {
                return (
                  <path
                    aria-label={`${item.kind} ${item.elementRef}`}
                    className={primitiveClasses(item, selectedGlobalId, selectedSpaceId)}
                    d={linearPath(item)}
                    fill="none"
                    key={item.id}
                    onClick={() => onSelect({ globalId: item.elementRef, kind: item.kind })}
                    strokeWidth={Math.max(item.width ?? 0.12, 0.12)}
                  />
                );
              }

              if (visualItemIds.has(item.visualRef) || visualItemIds.has(item.elementRef)) {
                return null;
              }

              const width = Math.max(item.size[0], 0.28);
              const height = Math.max(item.size[1], 0.28);
              const fittingSize = Math.max(Math.min(width, height, 0.9), 0.28);
              return (
                <g
                  aria-label={`${item.kind} ${item.elementRef}`}
                  className={primitiveClasses(item, selectedGlobalId, selectedSpaceId)}
                  data-edit-id={item.id}
                  data-position={item.position.join(",")}
                  key={item.id}
                  onClick={() => onSelect({ globalId: item.elementRef, kind: item.kind })}
                >
                  <g transform={`translate(${item.position[0]} ${item.position[1]}) rotate(${(item.rotation * 180) / Math.PI})`}>
                    {item.kind === "mech-terminal" ? (
                      <rect height={height} width={width} x={-width / 2} y={-height / 2} />
                    ) : item.kind === "mech-equipment" ? (
                      <rect
                        height={height}
                        rx={0.06}
                        ry={0.06}
                        width={width}
                        x={-width / 2}
                        y={-height / 2}
                      />
                    ) : (
                      <circle r={fittingSize * 0.28} />
                    )}
                  </g>
                </g>
              );
            })}
          </g>
        </g>

        <g className="plan-layer labels">
          {labelSpaces.map((space) => (
            <text
              aria-label={`plan-label ${space.globalId}`}
              className={space.globalId === selectedSpaceId ? "plan-label selected" : "plan-label"}
              key={`label-${space.globalId}`}
              onClick={() => onSelect({ globalId: space.globalId, kind: "space" })}
              style={{ fontSize: `${primaryFontSize}px` }}
              x={space.labelPoint[0]}
              y={flipY(storey, space.labelPoint[1])}
            >
              <tspan className="primary" x={space.labelPoint[0]} dy="0">
                {space.label}
              </tspan>
              {space.secondaryLabel ? (
                <tspan
                  className="secondary"
                  style={{ fontSize: `${secondaryFontSize}px` }}
                  x={space.labelPoint[0]}
                  dy="1.1em"
                >
                  {space.secondaryLabel}
                </tspan>
              ) : null}
              {(() => {
                const load = loadsBySpaceId.get(space.globalId);
                if (!load || load.designCfm <= 0) return null;
                return (
                  <tspan
                    className="cfm"
                    style={{ fontSize: `${secondaryFontSize}px` }}
                    x={space.labelPoint[0]}
                    dy="1.1em"
                  >
                    {Math.round(load.designCfm)} CFM
                  </tspan>
                );
              })()}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}
