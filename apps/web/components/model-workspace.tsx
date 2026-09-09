"use client";

import type {
  ElementDetail,
  ModelSummary,
  ModelDiscipline,
  ModelStatus,
  PlanStorey,
  SpaceSummary,
  StoreySummary,
  ViewerMode
} from "@openmep/model-core";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  Flame,
  Layers,
  Maximize2,
  Minus,
  MousePointer2,
  Move,
  PenTool,
  Plus,
  Redo2,
  Ruler,
  Scan,
  Search,
  Shield,
  Sparkles,
  Undo2,
  X,
  Zap
} from "lucide-react";

import { IfcViewer } from "./ifc-viewer";
import { LoadDashboard } from "./load-dashboard";
import { PlanCanvas } from "./plan-canvas";

type Props = {
  modelId: string;
};

type ListResponse<T> = {
  items: T[];
};

type PlanSelection = {
  globalId: string;
  kind: string;
};

export function shouldPollWorkspaceModel(status: ModelStatus | null): boolean {
  return status === "uploaded" || status === "processing";
}

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

function parseInitialMode(params: URLSearchParams): ViewerMode {
  const raw = params.get("mode");
  if (raw === "2d" || raw === "3d" || raw === "plan") {
    return raw;
  }
  return "3d";
}

function parseBooleanParam(params: URLSearchParams, name: string): boolean {
  const raw = params.get(name);
  return raw === "1" || raw === "true" || raw === "yes" || raw === "plan";
}

function formatWholeNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function ModelWorkspace({ modelId }: Props) {
  const searchParams = useSearchParams();
  const initialStoreyId = searchParams.get("storeyId");
  const capturePlanOnly = parseBooleanParam(searchParams, "capture");
  const [model, setModel] = useState<ModelSummary | null>(null);
  const [storeys, setStoreys] = useState<StoreySummary[]>([]);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [mode, setMode] = useState<ViewerMode>(() => parseInitialMode(searchParams));
  const [selectedStoreyId, setSelectedStoreyId] = useState<string | null>(initialStoreyId);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [selectedElement, setSelectedElement] = useState<ElementDetail | null>(null);
  const [search, setSearch] = useState("");
  const [showAnalyze, setShowAnalyze] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [visibleDisciplines, setVisibleDisciplines] = useState<Record<ModelDiscipline, boolean>>({
    architecture: true,
    mechanical: true
  });

  // Plan-specific state
  const [planStorey, setPlanStorey] = useState<PlanStorey | null>(null);
  const [planStoreyLoading, setPlanStoreyLoading] = useState(false);
  const [showMechanicalEditOverlay, setShowMechanicalEditOverlay] = useState(() =>
    parseBooleanParam(searchParams, "editOverlay")
  );

  // Sidebar tree expand state
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({
    mechanical: true,
    electrical: false,
    plumbing: false,
    fire: false
  });

  const deferredSearch = useDeferredValue(search);

  // --- Data fetching: model + storeys ---
  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;

    const load = async () => {
      try {
        const [modelResponse, storeysResponse] = await Promise.all([
          fetch(`/api/models/${modelId}`, { cache: "no-store" }),
          fetch(`/api/models/${modelId}/storeys`, { cache: "no-store" })
        ]);

        if (!modelResponse.ok) {
          throw new Error(await readErrorMessage(modelResponse, `Unable to fetch model ${modelId}.`));
        }
        if (!storeysResponse.ok) {
          throw new Error(
            await readErrorMessage(storeysResponse, `Unable to fetch storeys for model ${modelId}.`)
          );
        }

        const modelPayload = (await modelResponse.json()) as ModelSummary;
        const storeyPayload = (await storeysResponse.json()) as ListResponse<StoreySummary>;
        if (cancelled) return;

        setModel(modelPayload);
        setStoreys(storeyPayload.items);
        setSelectedStoreyId((current) =>
          current && storeyPayload.items.some((s) => s.globalId === current)
            ? current
            : initialStoreyId && storeyPayload.items.some((s) => s.globalId === initialStoreyId)
              ? initialStoreyId
              : storeyPayload.items[0]?.globalId ?? null
        );

        const shouldPoll =
          shouldPollWorkspaceModel(modelPayload.status) ||
          modelPayload.planStatus === "processing";
        if (shouldPoll) {
          timeoutId = window.setTimeout(() => void load(), 4000);
        }
      } catch (error) {
        if (!cancelled) {
          setViewerError(error instanceof Error ? error.message : "Unable to load workspace.");
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [initialStoreyId, modelId]);

  // --- Discipline visibility from sources ---
  useEffect(() => {
    if (!model) return;
    const sources = model.sources ?? [];
    if (sources.length === 0) {
      setVisibleDisciplines({ architecture: true, mechanical: false });
      return;
    }
    const available = new Set(sources.map((s) => s.discipline));
    setVisibleDisciplines({
      architecture: available.has("architecture"),
      mechanical: available.has("mechanical")
    });
  }, [model]);

  // --- Spaces fetch (3D/2D modes) ---
  useEffect(() => {
    if (mode === "plan" || !selectedStoreyId) {
      if (mode !== "plan") setSpaces([]);
      return;
    }

    let active = true;
    void (async () => {
      const response = await fetch(
        `/api/models/${modelId}/spaces?storeyId=${encodeURIComponent(selectedStoreyId)}`,
        { cache: "no-store" }
      );
      if (!response.ok || !active) return;
      const payload = (await response.json()) as ListResponse<SpaceSummary>;
      if (!active) return;
      setSpaces(payload.items);
      setSelectedSpaceId((current) => {
        if (!current) return null;
        return payload.items.some((s) => s.globalId === current)
          ? current
          : null;
      });
    })();

    return () => { active = false; };
  }, [modelId, selectedStoreyId, mode]);

  // --- Plan data fetch (plan mode only) ---
  useEffect(() => {
    if (mode !== "plan" || !selectedStoreyId) {
      if (mode !== "plan") setPlanStorey(null);
      setPlanStoreyLoading(false);
      return;
    }

    let active = true;
    let timeoutId: number | null = null;
    let hasLoadedPlan = false;

    const load = async () => {
      if (active && !hasLoadedPlan) {
        setPlanStoreyLoading(true);
      }
      const layers = [
        "architecture",
        "mechanicalVisual2D",
        "loads",
        ...(showMechanicalEditOverlay ? ["mechanicalEdit2D"] : [])
      ];
      const planParams = new URLSearchParams({
        storeyId: selectedStoreyId,
        layers: layers.join(",")
      });
      if (capturePlanOnly) {
        planParams.set("readOnly", "1");
        planParams.set("poll", String(Date.now()));
      }
      const response = await fetch(
        `/api/models/${modelId}/plan?${planParams.toString()}`,
        { cache: "no-store" }
      );

      if (!response.ok) {
        if (active) {
          setPlanStorey(null);
          const message = await readErrorMessage(response, "Unable to load plan view.");
          setViewerError(message);
          if (response.status === 409 && message.includes("not ready yet")) {
            timeoutId = window.setTimeout(() => void load(), 4000);
          } else {
            setPlanStoreyLoading(false);
          }
        }
        return;
      }

      const payload = (await response.json()) as PlanStorey;
      if (!active) return;

      setViewerError(null);
      setPlanStorey(payload);
      hasLoadedPlan = true;
      setPlanStoreyLoading(false);
      setSelectedSpaceId((current) =>
        current && payload.architecture.spaces.some((s) => s.globalId === current)
          ? current
          : null
      );
      setSelectedElement(null);
      if (capturePlanOnly) {
        timeoutId = window.setTimeout(() => void load(), 1000);
      }
    };

    void load();
    return () => {
      active = false;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [capturePlanOnly, modelId, selectedStoreyId, mode, showMechanicalEditOverlay]);

  // --- Derived data ---
  const planSpaces = useMemo(
    () => planStorey?.architecture?.spaces ?? [],
    [planStorey]
  );

  const activeSpaces = mode === "plan" ? planSpaces : spaces;

  const filteredSpaces = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    if (!query) return activeSpaces;
    return activeSpaces.filter((space) => {
      const label = "label" in space ? space.label : (space as SpaceSummary).longName ?? (space as SpaceSummary).name;
      const secondary =
        "secondaryLabel" in space
          ? (space as { secondaryLabel?: string }).secondaryLabel ?? ""
          : (space as SpaceSummary).name;
      return `${label} ${secondary}`.toLowerCase().includes(query);
    });
  }, [deferredSearch, activeSpaces, mode]);

  const selectedSpace = mode === "plan"
    ? planSpaces.find((s) => s.globalId === selectedSpaceId) ?? null
    : spaces.find((s) => s.globalId === selectedSpaceId) ?? null;

  const selectedPlanLoad =
    mode === "plan" && selectedSpaceId
      ? planStorey?.loads.spaces.find((load) => load.spaceGlobalId === selectedSpaceId) ?? null
      : null;

  const visibleSources = (model?.sources ?? []).filter(
    (source) => visibleDisciplines[source.discipline]
  );

  const modelLayers = (model?.sources ?? []).map((source) => ({
    label: source.discipline === "architecture" ? "Architecture" : "Mechanical",
    discipline: source.discipline,
    enabled: visibleDisciplines[source.discipline],
    color: source.discipline === "architecture" ? "var(--muted)" : "var(--red)"
  }));

  // --- Handlers ---
  const onSelectElement3D = async (globalId: string | null) => {
    if (!globalId) {
      setSelectedElement(null);
      return;
    }
    const response = await fetch(
      `/api/models/${modelId}/elements/${encodeURIComponent(globalId)}`,
      { cache: "no-store" }
    );
    if (!response.ok) return;
    setSelectedElement((await response.json()) as ElementDetail);
  };

  const onSelectElementPlan = async (selection: PlanSelection) => {
    if (selection.kind === "space") {
      setSelectedSpaceId(selection.globalId);
      setSelectedElement(null);
      return;
    }
    const response = await fetch(
      `/api/models/${modelId}/elements/${encodeURIComponent(selection.globalId)}`,
      { cache: "no-store" }
    );
    if (!response.ok) {
      setViewerError(await readErrorMessage(response, "Unable to load element details."));
      return;
    }
    setSelectedSpaceId(null);
    setSelectedElement((await response.json()) as ElementDetail);
  };

  const onStoreyChange = (nextStoreyId: string) => {
    setSelectedStoreyId(nextStoreyId);
    setSelectedElement(null);
  };

  const onRoomSelect = (spaceGlobalId: string) => {
    setSelectedSpaceId(spaceGlobalId || null);
    setSelectedElement(null);
  };

  const toggleCategory = (key: string) => {
    setExpandedCategories((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const selectedGlobalId = selectedElement?.globalId ?? selectedSpaceId;

  return (
    <main className={capturePlanOnly ? "app-shell plan-capture-mode" : "app-shell"}>
      {/* ========== TOP NAV ========== */}
      <nav className="top-nav">
        <div className="nav-left">
          <Link href="/" className="nav-logo">M</Link>
          <span className="nav-app-name">MEPFLOW</span>
          <span className="nav-divider" />
          <button className="nav-menu-item" type="button">File</button>
          <button className="nav-menu-item" type="button">Edit</button>
          <button className="nav-menu-item" type="button">View</button>
          <button className="nav-menu-item" type="button">Insert</button>
          <button
            className={showAnalyze ? "nav-menu-item active" : "nav-menu-item"}
            type="button"
            onClick={() => setShowAnalyze((value) => !value)}
          >
            Analyze
          </button>
        </div>

        <div className="nav-center">
          <div className="search-bar">
            <Search className="search-icon" size={14} />
            <input
              placeholder="Search components..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="search-shortcut">⌘K</span>
          </div>
        </div>

        <div className="nav-right">
          {mode === "plan" && selectedStoreyId && (
            <Link className="nav-btn nav-btn-accent" href={`/models/${modelId}/design?storeyId=${encodeURIComponent(selectedStoreyId)}`}>
              Airflow design
            </Link>
          )}
          <div className="mode-toggle">
            <button
              className={mode === "3d" ? "mode-button active" : "mode-button"}
              onClick={() => setMode("3d")}
              type="button"
            >
              3D
            </button>
            <button
              className={mode === "2d" ? "mode-button active" : "mode-button"}
              onClick={() => setMode("2d")}
              type="button"
            >
              2D
            </button>
            <button
              className={mode === "plan" ? "mode-button active" : "mode-button"}
              onClick={() => setMode("plan")}
              type="button"
            >
              Plan
            </button>
          </div>
          <button className="nav-btn nav-btn-accent" type="button">
            <Sparkles size={14} />
            AI Assist
          </button>
          <button className="nav-icon-btn" type="button" aria-label="Undo">
            <Undo2 size={18} />
          </button>
          <button className="nav-icon-btn" type="button" aria-label="Redo">
            <Redo2 size={18} />
          </button>
          <button className="nav-btn nav-btn-ghost" type="button">Share</button>
        </div>
      </nav>

      {showAnalyze ? (
        <LoadDashboard
          modelId={modelId}
          storeys={storeys}
          selectedStoreyId={selectedStoreyId}
          onStoreyChange={onStoreyChange}
          onClose={() => setShowAnalyze(false)}
        />
      ) : (
        <>
      {/* ========== BODY (3 columns) ========== */}
      <div className="body-layout">
        {/* --- Left Sidebar --- */}
        <aside className="left-sidebar">
          <div className="section-label">
            <span>COMPONENTS</span>
            <button type="button" aria-label="Add component"><Plus size={14} /></button>
          </div>

          {/* Mechanical category */}
          <div className="tree-category">
            <button
              className="tree-category-header"
              type="button"
              onClick={() => toggleCategory("mechanical")}
            >
              <Flame size={16} className="cat-icon" style={{ color: "var(--red)" }} />
              <span className="cat-label">Mechanical</span>
              {expandedCategories.mechanical
                ? <ChevronDown size={14} className="cat-chevron" />
                : <ChevronRight size={14} className="cat-chevron" />}
            </button>
            {expandedCategories.mechanical && (
              <div className="tree-items">
                <button className="tree-item" type="button">
                  <span className="tree-item-icon" style={{ background: "var(--red-dark)", color: "var(--red)" }}>T</span>
                  Thermostat
                </button>
                <button className="tree-item" type="button">
                  <span className="tree-item-icon" style={{ background: "var(--red-dark)", color: "var(--red)" }}>D</span>
                  Diffuser
                </button>
                <button className="tree-item" type="button">
                  <span className="tree-item-icon" style={{ background: "var(--red-dark)", color: "var(--red)" }}>A</span>
                  AHU Unit
                </button>
                <button className="tree-item" type="button">
                  <span className="tree-item-icon" style={{ background: "var(--red-dark)", color: "var(--red)" }}>V</span>
                  VAV Box
                </button>
              </div>
            )}
          </div>

          {/* Electrical category */}
          <div className="tree-category">
            <button
              className="tree-category-header"
              type="button"
              onClick={() => toggleCategory("electrical")}
            >
              <Zap size={16} className="cat-icon" style={{ color: "var(--yellow)" }} />
              <span className="cat-label">Electrical</span>
              {expandedCategories.electrical
                ? <ChevronDown size={14} className="cat-chevron" />
                : <ChevronRight size={14} className="cat-chevron" />}
            </button>
          </div>

          {/* Plumbing category */}
          <div className="tree-category">
            <button
              className="tree-category-header"
              type="button"
              onClick={() => toggleCategory("plumbing")}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="cat-icon">
                <path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z" />
                <path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97" />
              </svg>
              <span className="cat-label">Plumbing</span>
              {expandedCategories.plumbing
                ? <ChevronDown size={14} className="cat-chevron" />
                : <ChevronRight size={14} className="cat-chevron" />}
            </button>
          </div>

          {/* Fire Protection category */}
          <div className="tree-category">
            <button
              className="tree-category-header"
              type="button"
              onClick={() => toggleCategory("fire")}
            >
              <Shield size={16} className="cat-icon" style={{ color: "var(--green)" }} />
              <span className="cat-label">Fire Protection</span>
              {expandedCategories.fire
                ? <ChevronDown size={14} className="cat-chevron" />
                : <ChevronRight size={14} className="cat-chevron" />}
            </button>
          </div>

          <div className="sidebar-divider" />

          {/* Layers section */}
          <div className="section-label">
            <span>LAYERS</span>
            <button type="button" aria-label="Toggle all layers"><Eye size={14} /></button>
          </div>

          {modelLayers.map((layer) => (
            <button
              className="layer-row"
              key={layer.label}
              type="button"
              onClick={() =>
                setVisibleDisciplines((current) => ({
                  ...current,
                  [layer.discipline]: !current[layer.discipline]
                }))
              }
            >
              <span
                className={layer.enabled ? "layer-checkbox" : "layer-checkbox off"}
                style={layer.enabled ? { background: layer.color } : undefined}
              />
              <span className={layer.enabled ? undefined : "layer-label-muted"}>
                {layer.label}
              </span>
            </button>
          ))}

          {mode === "plan" && (
            <button
              className="layer-row"
              type="button"
              onClick={() => setShowMechanicalEditOverlay((v) => !v)}
            >
              <span
                className={showMechanicalEditOverlay ? "layer-checkbox" : "layer-checkbox off"}
                style={showMechanicalEditOverlay ? { background: "var(--accent)" } : undefined}
              />
              <span className={showMechanicalEditOverlay ? undefined : "layer-label-muted"}>
                Mech. Edit Overlay
              </span>
            </button>
          )}
        </aside>

        {/* --- Canvas Area --- */}
        <div className="canvas-area">
          {mode === "plan" ? (
            planStoreyLoading && !planStorey ? (
              <div className="empty-state">Loading plan view...</div>
            ) : (
              <PlanCanvas
                onSelect={onSelectElementPlan}
                showArchitecture={visibleDisciplines.architecture}
                showMechanicalEditOverlay={showMechanicalEditOverlay}
                showMechanical={visibleDisciplines.mechanical}
                selectedGlobalId={selectedGlobalId}
                selectedSpaceId={selectedSpaceId}
                storey={planStorey}
              />
            )
          ) : (
            <IfcViewer
              mode={mode}
              modelId={modelId}
              sources={visibleSources}
              selectedStoreyId={selectedStoreyId}
              selectedSpace={
                selectedSpace && "name" in selectedSpace
                  ? (selectedSpace as SpaceSummary)
                  : null
              }
              storeys={storeys}
              onError={setViewerError}
              onSelectElement={onSelectElement3D}
            />
          )}

          {viewerError && <p className="error-banner">{viewerError}</p>}

          {/* Floating canvas toolbar */}
          <div className="canvas-toolbar">
            <button className="canvas-tool active" type="button" aria-label="Select">
              <MousePointer2 size={14} />
            </button>
            <button className="canvas-tool" type="button" aria-label="Move">
              <Move size={14} />
            </button>
            <button className="canvas-tool" type="button" aria-label="Pen">
              <PenTool size={14} />
            </button>
            <button className="canvas-tool" type="button" aria-label="Ruler">
              <Ruler size={14} />
            </button>
            <button className="canvas-tool" type="button" aria-label="Measure">
              <Scan size={14} />
            </button>
          </div>
        </div>

        {/* --- Right Panel --- */}
        <aside className="right-panel">
          <div className="panel-header">
            <span className="section-label" style={{ padding: 0, height: "auto" }}>PROPERTIES</span>
            <button type="button" aria-label="Close panel"><X size={14} /></button>
          </div>

          {selectedElement ? (
            <>
              <div className="component-info">
                <p className="component-info-title">
                  {selectedElement.name ?? selectedElement.globalId}
                </p>
                <p className="component-info-sub">{selectedElement.ifcClass}</p>
                <div className="status-row">
                  <span className="status-dot" />
                  <span className="status-text">Connected</span>
                </div>
              </div>

              <div className="panel-divider" />

              <div className="props-section">
                <div className="prop-row">
                  <span className="prop-label">Type</span>
                  <span className="prop-value">{selectedElement.ifcClass}</span>
                </div>
                <div className="prop-row">
                  <span className="prop-label">Airflow</span>
                  <span className="prop-value highlight">{selectedElement.airflowType}</span>
                </div>
                {selectedElement.systemAssignments.map((assignment) => (
                  <div className="prop-row" key={assignment.systemGlobalId}>
                    <span className="prop-label">System</span>
                    <span className="prop-value">
                      {assignment.name ?? assignment.systemGlobalId}
                    </span>
                  </div>
                ))}
                {Object.entries(selectedElement.properties)
                  .slice(0, 6)
                  .map(([key, value]) => (
                    <div className="prop-row" key={key}>
                      <span className="prop-label">{key}</span>
                      <span className="prop-value">{JSON.stringify(value)}</span>
                    </div>
                  ))}
              </div>
            </>
          ) : selectedSpace ? (
            <>
              <div className="component-info">
                <p className="component-info-title">
                  {"label" in selectedSpace ? selectedSpace.label : (selectedSpace as SpaceSummary).longName ?? (selectedSpace as SpaceSummary).name}
                </p>
                <p className="component-info-sub">Room / Space</p>
                <div className="status-row">
                  <span className="status-dot" />
                  <span className="status-text">
                    {"area" in selectedSpace && selectedSpace.area
                      ? `${selectedSpace.area.toFixed(1)} m²`
                      : "Area unavailable"}
                  </span>
                </div>
              </div>
              {selectedPlanLoad ? (
                <>
                  <div className="panel-divider" />
                  <div className="props-section">
                    <div className="prop-row">
                      <span className="prop-label">Design CFM</span>
                      <span className="prop-value highlight">
                        {formatWholeNumber(selectedPlanLoad.designCfm)}
                      </span>
                    </div>
                    <div className="prop-row">
                      <span className="prop-label">Ventilation CFM</span>
                      <span className="prop-value">
                        {formatWholeNumber(selectedPlanLoad.ventilation.voz)}
                      </span>
                    </div>
                    {selectedPlanLoad.thermal.envelopeBtuH > 0 ? (
                      <div className="prop-row">
                        <span className="prop-label">Envelope Load</span>
                        <span className="prop-value">
                          {formatWholeNumber(selectedPlanLoad.thermal.envelopeBtuH)} Btu/h
                        </span>
                      </div>
                    ) : null}
                    <div className="prop-row">
                      <span className="prop-label">Space Type</span>
                      <span className="prop-value">{selectedPlanLoad.spaceTypeDisplayName}</span>
                    </div>
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <div className="component-info">
              <p className="component-info-sub">
                {mode === "plan"
                  ? "Click the plan to inspect rooms and elements."
                  : "Click geometry in the viewer to inspect IFC metadata."}
              </p>
            </div>
          )}

          <div className="panel-divider" />

          {/* AI Suggestions (placeholder) */}
          <div className="ai-section">
            <div className="ai-section-header">
              <Sparkles size={14} style={{ color: "var(--accent)" }} />
              <span className="ai-section-title">AI SUGGESTIONS</span>
            </div>
            <div className="ai-card" style={{ borderColor: "rgba(34, 211, 238, 0.2)" }}>
              <p className="ai-card-title">Optimize Placement</p>
              <p className="ai-card-desc">
                Analyze component positions for better zone coverage and energy efficiency.
              </p>
              <button className="ai-card-btn" type="button">
                <Sparkles size={12} />
                Apply
              </button>
            </div>
            <div className="ai-card">
              <p className="ai-card-title">Energy Warning</p>
              <p className="ai-card-desc">
                Current duct routing may add pressure drop. Consider rerouting.
              </p>
            </div>
          </div>
        </aside>
      </div>

      {/* ========== BOTTOM TOOLBAR ========== */}
      <div className="bottom-toolbar">
        <div className="toolbar-left">
          <select
            className="toolbar-btn toolbar-btn-filled"
            onChange={(e) => onStoreyChange(e.target.value)}
            value={selectedStoreyId ?? ""}
          >
            {storeys.map((storey) => (
              <option key={storey.globalId} value={storey.globalId}>
                {storey.sortOrder + 1} - {storey.name}
              </option>
            ))}
          </select>
          <select
            className="toolbar-btn toolbar-btn-filled"
            onChange={(e) => onRoomSelect(e.target.value)}
            value={selectedSpaceId ?? ""}
          >
            <option value="">All Rooms</option>
            {activeSpaces.map((space) => {
              const label =
                "label" in space
                  ? space.label
                  : (space as SpaceSummary).longName ?? (space as SpaceSummary).name;
              return (
                <option key={space.globalId} value={space.globalId}>
                  {label}
                </option>
              );
            })}
          </select>
          <button className="toolbar-btn toolbar-btn-ghost" type="button">Units</button>
          <button className="toolbar-btn toolbar-btn-ghost" type="button">Scale</button>
          {mode === "plan" && planStorey ? (
            <div className="cfm-summary" aria-label="Storey CFM summary">
              <span className="cfm-summary-label">Total Design CFM</span>
              <span className="cfm-summary-value">
                {formatWholeNumber(planStorey.loads.totals.designCfm)}
              </span>
              <span className="cfm-summary-meta">
                {formatWholeNumber(planStorey.loads.totals.ventilationCfm)} ventilation
                {planStorey.loads.climate
                  ? ` · climate ${planStorey.loads.climate.zone} · cooling DB ${formatWholeNumber(planStorey.loads.climate.coolingDryBulbF)}°F`
                  : ""}
              </span>
            </div>
          ) : null}
          <button className="toolbar-btn toolbar-btn-ghost" type="button">Edit model</button>
          <button className="toolbar-btn toolbar-btn-accent" type="button">
            <Sparkles size={14} />
            Optimize
          </button>
        </div>

        <div className="toolbar-right">
          <div className="zoom-controls">
            <button type="button" aria-label="Zoom out"><Minus size={16} /></button>
            <span className="zoom-level">100%</span>
            <button type="button" aria-label="Zoom in"><Plus size={16} /></button>
            <button type="button" aria-label="Fit to view"><Maximize2 size={16} /></button>
          </div>
        </div>
      </div>
        </>
      )}
    </main>
  );
}
