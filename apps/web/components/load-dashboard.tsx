"use client";

import type {
  Bounds2D,
  PlanPolygon,
  PlanSpace,
  PlanStorey,
  SpaceLoad,
  StoreySummary
} from "@openmep/model-core";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Download,
  Flame,
  Gauge,
  Leaf,
  Ruler,
  Snowflake,
  Thermometer,
  Wind,
  X
} from "lucide-react";

type Props = {
  modelId: string;
  storeys: StoreySummary[];
  selectedStoreyId: string | null;
  onStoreyChange: (storeyGlobalId: string) => void;
  onClose: () => void;
};

// --- Engineering constants (mirror the server-side load engine) ---
const BTUH_PER_TON = 12_000;
const BTUH_PER_MBH = 1_000;

// --- Number formatting ---
function whole(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function decimals(value: number, places: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places
  });
}

function percent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${decimals((numerator / denominator) * 100, 1)}%`;
}

function perArea(value: number, areaSqft: number, places = 2): string {
  if (areaSqft <= 0) return "—";
  return decimals(value / areaSqft, places);
}

// --- Design-CFM driver: which sizing term won max(Voz, cooling, exhaust, est)? ---
// The engine sizes designCfm = MAX(ventilation Voz, thermal cooling CFM, minimum
// exhaust CFM, cfm/ft² estimator). SpaceLoad persists Voz, cooling, and the
// estimator; exhaust is not persisted, so when designCfm exceeds every persisted
// term we attribute it to the exhaust minimum (and the engine confirms this via a
// diagnostic). This keeps the label honest rather than inventing an exhaust value.
type Driver = "ventilation" | "cooling" | "exhaust" | "estimator";

const DRIVER_LABEL: Record<Driver, string> = {
  ventilation: "Ventilation",
  cooling: "Cooling load",
  exhaust: "Exhaust min.",
  estimator: "cfm/ft² est."
};

function designDriver(load: SpaceLoad): Driver {
  const candidates: ReadonlyArray<{ key: Driver; value: number }> = [
    { key: "ventilation", value: load.ventilation.voz },
    { key: "cooling", value: load.thermal.cfm },
    { key: "estimator", value: load.estimator.cfm }
  ];
  const maxKnown = candidates.reduce((best, candidate) =>
    candidate.value > best.value ? candidate : best
  );
  const tolerance = Math.max(1, load.designCfm * 0.01);
  if (load.designCfm > maxKnown.value + tolerance) {
    return "exhaust";
  }
  return maxKnown.key;
}

// --- Floor-plan heatmap geometry (mirrors PlanCanvas's coordinate handling) ---
type ViewBox = { minX: number; minY: number; width: number; height: number };

function polygonPath(polygon: PlanPolygon): string {
  const segments = [polygon.outer, ...polygon.holes].map((ring) => {
    const [first, ...rest] = ring;
    return `M ${first[0]} ${first[1]} ${rest
      .map(([x, y]) => `L ${x} ${y}`)
      .join(" ")} Z`;
  });
  return segments.join(" ");
}

function spacePath(space: PlanSpace): string {
  return space.polygons.map(polygonPath).join(" ");
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

function formatViewBox(viewBox: ViewBox): string {
  return `${viewBox.minX} ${viewBox.minY} ${viewBox.width} ${viewBox.height}`;
}

function flipY(storey: PlanStorey, y: number): number {
  return storey.contextBounds.min[1] + storey.contextBounds.max[1] - y;
}

// Heatmap bucket — exhaust-driven rooms get their own color; the rest are graded
// by design CFM intensity (cfm/ft²), the most common engineering sanity check.
type LoadBand = "exhaust" | "high" | "medium" | "low" | "none";

const BAND_COLOR: Record<LoadBand, string> = {
  exhaust: "var(--blue)",
  high: "var(--red)",
  medium: "var(--accent-secondary)",
  low: "var(--success)",
  none: "var(--muted)"
};

function loadBand(load: SpaceLoad | undefined): LoadBand {
  if (!load || load.designCfm <= 0) return "none";
  if (designDriver(load) === "exhaust") return "exhaust";
  const intensity = load.areaSqft > 0 ? load.designCfm / load.areaSqft : 0;
  if (intensity >= 1.2) return "high";
  if (intensity >= 0.8) return "medium";
  return "low";
}

export function LoadDashboard({
  modelId,
  storeys,
  selectedStoreyId,
  onStoreyChange,
  onClose
}: Props) {
  const [storey, setStorey] = useState<PlanStorey | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedStoreyId) {
      setStorey(null);
      return;
    }
    let active = true;
    let timeoutId: number | null = null;

    const load = async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        storeyId: selectedStoreyId,
        layers: "architecture,loads"
      });
      try {
        const response = await fetch(
          `/api/models/${modelId}/plan?${params.toString()}`,
          { cache: "no-store" }
        );
        if (!active) return;
        if (!response.ok) {
          const payload = (await response
            .json()
            .catch(() => ({}))) as { error?: string };
          const message = payload.error ?? "Unable to load calculations.";
          // Plan still generating — retry shortly.
          if (response.status === 409 && message.includes("not ready")) {
            timeoutId = window.setTimeout(() => void load(), 4000);
            setError(message);
            return;
          }
          setStorey(null);
          setError(message);
          setLoading(false);
          return;
        }
        const payload = (await response.json()) as PlanStorey;
        if (!active) return;
        setStorey(payload);
        setSelectedSpaceId((current) =>
          current &&
          payload.loads.spaces.some((load) => load.spaceGlobalId === current)
            ? current
            : null
        );
        setError(null);
        setLoading(false);
      } catch (caught) {
        if (!active) return;
        setStorey(null);
        setError(
          caught instanceof Error ? caught.message : "Unable to load calculations."
        );
        setLoading(false);
      }
    };

    void load();
    return () => {
      active = false;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [modelId, selectedStoreyId]);

  const loads = storey?.loads ?? null;
  const climate = loads?.climate ?? null;

  // Match every load row to its plan space so the schedule can show the real
  // room name/number alongside the ASHRAE space-type classification.
  const spacesByGlobalId = useMemo(() => {
    const map = new Map<string, PlanSpace>();
    for (const space of storey?.architecture.spaces ?? []) {
      map.set(space.globalId, space);
    }
    return map;
  }, [storey]);

  const rows = useMemo(() => {
    if (!loads) return [];
    return [...loads.spaces]
      .map((load) => ({
        load,
        space: spacesByGlobalId.get(load.spaceGlobalId) ?? null,
        driver: designDriver(load)
      }))
      .sort((a, b) => b.load.designCfm - a.load.designCfm);
  }, [loads, spacesByGlobalId]);

  const totals = loads?.totals ?? null;
  const totalArea = useMemo(
    () => rows.reduce((sum, row) => sum + row.load.areaSqft, 0),
    [rows]
  );
  const totalOccupants = useMemo(
    () => rows.reduce((sum, row) => sum + row.load.occupants, 0),
    [rows]
  );
  const totalInternal = useMemo(
    () => rows.reduce((sum, row) => sum + row.load.thermal.internalBtuH, 0),
    [rows]
  );

  const selectedRow =
    rows.find((row) => row.load.spaceGlobalId === selectedSpaceId) ?? null;

  const heatmapViewBox = useMemo(
    () => (storey ? expandBounds(storey.focusBounds, 0.06) : null),
    [storey]
  );

  const onExportCsv = () => {
    if (!storey || !loads) return;
    const header = [
      "Room",
      "Space type (ASHRAE)",
      "Confidence",
      "Area ft2",
      "Occupants",
      "Sensible Btu/h",
      "Internal Btu/h",
      "Envelope Btu/h",
      "Ventilation Voz CFM",
      "Cooling CFM",
      "Estimator CFM",
      "Design CFM",
      "Design driver",
      "CFM/ft2"
    ];
    const lines = rows.map(({ load, space, driver }) => {
      const room = space?.label ?? load.spaceGlobalId;
      return [
        room,
        load.spaceTypeDisplayName,
        load.classificationConfidence,
        Math.round(load.areaSqft),
        load.occupants,
        Math.round(load.thermal.sensibleLoadBtuH),
        Math.round(load.thermal.internalBtuH),
        Math.round(load.thermal.envelopeBtuH),
        Math.round(load.ventilation.voz),
        Math.round(load.thermal.cfm),
        Math.round(load.estimator.cfm),
        Math.round(load.designCfm),
        DRIVER_LABEL[driver],
        load.areaSqft > 0 ? (load.designCfm / load.areaSqft).toFixed(3) : ""
      ]
        .map((cell) => {
          const text = String(cell);
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(",");
    });
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `load-schedule-${storey.name.replace(/\s+/g, "-")}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const hasData = Boolean(loads && rows.length > 0);

  return (
    <div className="lc-shell">
      {/* ===== Dashboard header ===== */}
      <header className="lc-header">
        <div className="lc-header-left">
          <button
            className="lc-back"
            type="button"
            onClick={onClose}
            aria-label="Back to model"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="lc-title-row">
              <h1 className="lc-title">Load Calculations</h1>
              {climate ? (
                <span className="lc-climate-chip">
                  <Thermometer size={12} />
                  Zone {climate.zone} · {climate.representativeCity}
                </span>
              ) : null}
            </div>
            <p className="lc-subtitle">
              ASHRAE 62.1 ventilation · sensible cooling = internal gains +
              envelope conduction (U·A·ΔT)
              {climate
                ? ` · cooling ${whole(climate.coolingDryBulbF)} °F DB / heating ${whole(
                    climate.heatingDryBulbF
                  )} °F DB`
                : " · site location unresolved — envelope skipped"}
            </p>
          </div>
        </div>
        <div className="lc-header-right">
          <select
            className="lc-storey-select"
            value={selectedStoreyId ?? ""}
            onChange={(event) => {
              setSelectedSpaceId(null);
              onStoreyChange(event.target.value);
            }}
          >
            {storeys.map((option) => (
              <option key={option.globalId} value={option.globalId}>
                {option.sortOrder + 1} — {option.name}
              </option>
            ))}
          </select>
          <button
            className="lc-btn"
            type="button"
            onClick={onExportCsv}
            disabled={!hasData}
          >
            <Download size={14} />
            Export schedule
          </button>
          <button
            className="lc-icon-btn"
            type="button"
            onClick={onClose}
            aria-label="Close analyze"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {/* ===== States ===== */}
      {error && !hasData ? (
        <div className="lc-state">{error}</div>
      ) : loading && !storey ? (
        <div className="lc-state">Calculating loads…</div>
      ) : !hasData ? (
        <div className="lc-state">
          No load data for this storey — classify spaces and generate the plan
          first.
        </div>
      ) : (
        <div className="lc-body">
          {/* ===== KPI cards ===== */}
          <div className="lc-kpi-grid">
            <div className="lc-card">
              <div className="lc-card-head">
                <span className="lc-card-label">Sensible Cooling</span>
                <Snowflake size={15} className="lc-card-icon accent" />
              </div>
              <div className="lc-card-value">
                {whole(totals!.sensibleLoadBtuH)}
                <span className="lc-card-unit">Btu/h</span>
              </div>
              <div className="lc-card-meta">
                {decimals(totals!.sensibleLoadBtuH / BTUH_PER_TON, 1)} tons ·{" "}
                {decimals(totals!.sensibleLoadBtuH / BTUH_PER_MBH, 1)} MBh
              </div>
            </div>

            <div className="lc-card">
              <div className="lc-card-head">
                <span className="lc-card-label">Design Supply Air</span>
                <Wind size={15} className="lc-card-icon accent" />
              </div>
              <div className="lc-card-value">
                {whole(totals!.designCfm)}
                <span className="lc-card-unit">CFM</span>
              </div>
              <div className="lc-card-meta">
                {perArea(totals!.designCfm, totalArea)} cfm/ft² ·{" "}
                {totals!.spaceCount} rooms
              </div>
            </div>

            <div className="lc-card">
              <div className="lc-card-head">
                <span className="lc-card-label">Outside Air (Voz)</span>
                <Leaf size={15} className="lc-card-icon success" />
              </div>
              <div className="lc-card-value">
                {whole(totals!.ventilationCfm)}
                <span className="lc-card-unit">CFM</span>
              </div>
              <div className="lc-card-meta">
                {percent(totals!.ventilationCfm, totals!.designCfm)} of supply ·
                ASHRAE 62.1
              </div>
            </div>

            <div className="lc-card">
              <div className="lc-card-head">
                <span className="lc-card-label">Envelope Conduction</span>
                <Flame size={15} className="lc-card-icon warn" />
              </div>
              <div className="lc-card-value">
                {whole(totals!.envelopeBtuH)}
                <span className="lc-card-unit">Btu/h</span>
              </div>
              <div className="lc-card-meta">
                {percent(totals!.envelopeBtuH, totals!.sensibleLoadBtuH)} of
                sensible · {whole(totalArea)} ft² · {totalOccupants} occ
              </div>
            </div>
          </div>

          {/* ===== Heatmap / breakdown + schedule ===== */}
          <div className="lc-main-grid">
            <section className="lc-panel lc-left">
              {selectedRow ? (
                <LoadBreakdown
                  row={selectedRow}
                  totalDesignCfm={totals!.designCfm}
                  onBack={() => setSelectedSpaceId(null)}
                />
              ) : (
                <>
                  <div className="lc-panel-head">
                    <span className="lc-panel-title">
                      <Ruler size={14} /> Floor Plan — Design CFM
                    </span>
                    <span className="lc-panel-sub">{storey!.name}</span>
                  </div>
                  {heatmapViewBox ? (
                    <div className="lc-heatmap">
                      <svg
                        viewBox={formatViewBox(heatmapViewBox)}
                        role="img"
                        aria-label="Design CFM heatmap"
                        preserveAspectRatio="xMidYMid meet"
                      >
                        <g
                          transform={`translate(0 ${
                            storey!.contextBounds.min[1] +
                            storey!.contextBounds.max[1]
                          }) scale(1 -1)`}
                        >
                          {storey!.architecture.spaces.map((space) => {
                            const load = loads!.spaces.find(
                              (entry) => entry.spaceGlobalId === space.globalId
                            );
                            const band = loadBand(load);
                            const selected = space.globalId === selectedSpaceId;
                            return (
                              <path
                                key={space.globalId}
                                d={spacePath(space)}
                                fillRule="evenodd"
                                className={
                                  selected ? "lc-room selected" : "lc-room"
                                }
                                style={{
                                  fill: BAND_COLOR[band],
                                  stroke: BAND_COLOR[band]
                                }}
                                onClick={() =>
                                  setSelectedSpaceId(
                                    load ? space.globalId : null
                                  )
                                }
                              />
                            );
                          })}
                        </g>
                        <g>
                          {storey!.architecture.spaces.map((space) => {
                            const load = loads!.spaces.find(
                              (entry) => entry.spaceGlobalId === space.globalId
                            );
                            if (!load || load.designCfm <= 0) return null;
                            const width =
                              space.bounds.max[0] - space.bounds.min[0];
                            const height =
                              space.bounds.max[1] - space.bounds.min[1];
                            // Hide labels for slivers that can't fit text.
                            if (
                              width < heatmapViewBox.width * 0.06 ||
                              height < heatmapViewBox.height * 0.05
                            ) {
                              return null;
                            }
                            const fontSize = heatmapViewBox.width * 0.014;
                            return (
                              <text
                                key={`label-${space.globalId}`}
                                className="lc-room-label"
                                x={space.labelPoint[0]}
                                y={flipY(storey!, space.labelPoint[1])}
                                style={{ fontSize: `${fontSize}px` }}
                                onClick={() =>
                                  setSelectedSpaceId(space.globalId)
                                }
                              >
                                {whole(load.designCfm)}
                              </text>
                            );
                          })}
                        </g>
                      </svg>
                    </div>
                  ) : null}
                  <div className="lc-legend">
                    <span>
                      <i style={{ background: BAND_COLOR.high }} /> High ≥1.2
                      cfm/ft²
                    </span>
                    <span>
                      <i style={{ background: BAND_COLOR.medium }} /> Medium
                    </span>
                    <span>
                      <i style={{ background: BAND_COLOR.low }} /> Low
                    </span>
                    <span>
                      <i style={{ background: BAND_COLOR.exhaust }} /> Exhaust min.
                    </span>
                  </div>
                </>
              )}
            </section>

            <section className="lc-panel lc-right">
              <div className="lc-panel-head">
                <span className="lc-panel-title">
                  <Gauge size={14} /> Room Load Schedule
                </span>
                <span className="lc-panel-sub">{rows.length} spaces</span>
              </div>
              <div className="lc-table-scroll">
                <table className="lc-table">
                  <thead>
                    <tr>
                      <th className="lc-col-room">Room</th>
                      <th className="num">Area ft²</th>
                      <th className="num">Occ</th>
                      <th className="num">Sensible Btu/h</th>
                      <th className="num">Voz CFM</th>
                      <th className="num">Design CFM</th>
                      <th>Driver</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ load, space, driver }) => {
                      const selected =
                        load.spaceGlobalId === selectedSpaceId;
                      const barPct =
                        totals!.designCfm > 0
                          ? Math.min(
                              100,
                              (load.designCfm /
                                Math.max(
                                  ...rows.map((r) => r.load.designCfm)
                                )) *
                                100
                            )
                          : 0;
                      return (
                        <tr
                          key={load.spaceGlobalId}
                          className={selected ? "selected" : undefined}
                          onClick={() =>
                            setSelectedSpaceId(
                              selected ? null : load.spaceGlobalId
                            )
                          }
                        >
                          <td className="lc-col-room">
                            <span className="lc-room-name">
                              {space?.label ?? "Unmapped space"}
                            </span>
                            <span className="lc-room-type">
                              {load.spaceTypeDisplayName}
                              {load.classificationConfidence !== "override" ? (
                                <span
                                  className={`lc-conf lc-conf-${load.classificationConfidence}`}
                                  title={`Classification: ${load.classificationConfidence}`}
                                >
                                  {load.classificationConfidence === "llm"
                                    ? "AI"
                                    : "auto"}
                                </span>
                              ) : null}
                            </span>
                          </td>
                          <td className="num">{whole(load.areaSqft)}</td>
                          <td className="num">{load.occupants}</td>
                          <td className="num">
                            {whole(load.thermal.sensibleLoadBtuH)}
                          </td>
                          <td className="num">
                            {whole(load.ventilation.voz)}
                          </td>
                          <td className="num lc-design-cell">
                            <span className="lc-bar-track">
                              <span
                                className="lc-bar-fill"
                                style={{
                                  width: `${barPct}%`,
                                  background: BAND_COLOR[loadBand(load)]
                                }}
                              />
                            </span>
                            <span className="lc-design-num">
                              {whole(load.designCfm)}
                            </span>
                          </td>
                          <td>
                            <span className={`lc-driver lc-driver-${driver}`}>
                              {DRIVER_LABEL[driver]}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="lc-col-room">Building total</td>
                      <td className="num">{whole(totalArea)}</td>
                      <td className="num">{totalOccupants}</td>
                      <td className="num">{whole(totals!.sensibleLoadBtuH)}</td>
                      <td className="num">{whole(totals!.ventilationCfm)}</td>
                      <td className="num lc-design-cell">
                        <span className="lc-design-num">
                          {whole(totals!.designCfm)}
                        </span>
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          </div>

          <p className="lc-footnote">
            Calculated by the MEPFLOW engine. Sensible cooling currently models
            internal gains (lighting, equipment, people) and steady-state
            envelope conduction; solar gain, latent load, infiltration and
            hour-of-day RTS/CTS lag are not yet modeled. Envelope U-factors are
            ASHRAE 90.1 code-minimum defaults by climate zone.
          </p>
        </div>
      )}
    </div>
  );
}

// ===== Selected-room load breakdown =====
type Row = {
  load: SpaceLoad;
  space: PlanSpace | null;
  driver: Driver;
};

function LoadBreakdown({
  row,
  totalDesignCfm,
  onBack
}: {
  row: Row;
  totalDesignCfm: number;
  onBack: () => void;
}) {
  const { load, space, driver } = row;
  const { internalBtuH, envelopeBtuH, sensibleLoadBtuH } = load.thermal;
  const internalPct =
    sensibleLoadBtuH > 0 ? (internalBtuH / sensibleLoadBtuH) * 100 : 0;
  const envelopePct =
    sensibleLoadBtuH > 0 ? (envelopeBtuH / sensibleLoadBtuH) * 100 : 0;

  const envelopeRows = Object.entries(load.thermal.envelopeBreakdown)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);

  // The four sizing candidates the engine takes a MAX over.
  const candidates: ReadonlyArray<{ key: Driver; label: string; value: number }> =
    [
      { key: "ventilation", label: "Ventilation (Voz)", value: load.ventilation.voz },
      { key: "cooling", label: "Cooling load", value: load.thermal.cfm },
      { key: "estimator", label: "cfm/ft² estimator", value: load.estimator.cfm }
    ];

  return (
    <>
      <div className="lc-panel-head">
        <button className="lc-back small" type="button" onClick={onBack}>
          <ArrowLeft size={13} /> All rooms
        </button>
        <span className="lc-panel-sub">{DRIVER_LABEL[driver]}-driven</span>
      </div>

      <div className="lc-bd-scroll">
        <div className="lc-bd-title">
          <span className="lc-room-name">{space?.label ?? "Unmapped space"}</span>
          <span className="lc-room-type">
            {load.spaceTypeDisplayName} · {whole(load.areaSqft)} ft² ·{" "}
            {load.occupants} occ
          </span>
        </div>

        {/* Sensible composition */}
        <div className="lc-bd-section">
          <div className="lc-bd-section-head">
            <span>Sensible cooling</span>
            <span className="mono">{whole(sensibleLoadBtuH)} Btu/h</span>
          </div>
          <div className="lc-composition">
            <span
              className="lc-comp-internal"
              style={{ width: `${internalPct}%` }}
              title={`Internal ${whole(internalBtuH)} Btu/h`}
            />
            <span
              className="lc-comp-envelope"
              style={{ width: `${envelopePct}%` }}
              title={`Envelope ${whole(envelopeBtuH)} Btu/h`}
            />
          </div>
          <div className="lc-kv">
            <span>
              <i className="dot internal" /> Internal gains
            </span>
            <span className="mono">
              {whole(internalBtuH)} Btu/h · {decimals(internalPct, 0)}%
            </span>
          </div>
          <div className="lc-kv">
            <span>
              <i className="dot envelope" /> Envelope conduction
            </span>
            <span className="mono">
              {whole(envelopeBtuH)} Btu/h · {decimals(envelopePct, 0)}%
            </span>
          </div>
        </div>

        {/* Envelope by assembly */}
        {envelopeRows.length > 0 ? (
          <div className="lc-bd-section">
            <div className="lc-bd-section-head">
              <span>Envelope by assembly</span>
              <span className="mono">U·A·ΔT</span>
            </div>
            {envelopeRows.map(([assembly, value]) => (
              <div className="lc-kv" key={assembly}>
                <span>{assembly}</span>
                <span className="mono">{whole(value)} Btu/h</span>
              </div>
            ))}
          </div>
        ) : null}

        {/* Ventilation (ASHRAE 62.1) */}
        <div className="lc-bd-section">
          <div className="lc-bd-section-head">
            <span>Ventilation — ASHRAE 62.1</span>
            <span className="mono">Voz {whole(load.ventilation.voz)} CFM</span>
          </div>
          <div className="lc-kv">
            <span>Area rate (Ra)</span>
            <span className="mono">
              {decimals(load.ventilation.ra, 2)} cfm/ft²
            </span>
          </div>
          <div className="lc-kv">
            <span>People rate (Rp)</span>
            <span className="mono">
              {decimals(load.ventilation.rp, 1)} cfm/person
            </span>
          </div>
          <div className="lc-kv">
            <span>Breathing-zone (Vbz)</span>
            <span className="mono">{whole(load.ventilation.vbz)} CFM</span>
          </div>
          <div className="lc-kv">
            <span>Zone effectiveness (Ez)</span>
            <span className="mono">{decimals(load.ventilation.ez, 2)}</span>
          </div>
        </div>

        {/* Design CFM sizing */}
        <div className="lc-bd-section">
          <div className="lc-bd-section-head">
            <span>Design CFM = MAX of</span>
            <span className="mono">{whole(load.designCfm)} CFM</span>
          </div>
          {candidates.map((candidate) => {
            const winner = candidate.key === driver;
            const pct =
              load.designCfm > 0
                ? Math.min(100, (candidate.value / load.designCfm) * 100)
                : 0;
            return (
              <div
                className={winner ? "lc-cand winner" : "lc-cand"}
                key={candidate.key}
              >
                <div className="lc-cand-head">
                  <span>{candidate.label}</span>
                  <span className="mono">{whole(candidate.value)} CFM</span>
                </div>
                <span className="lc-bar-track">
                  <span
                    className="lc-bar-fill"
                    style={{
                      width: `${pct}%`,
                      background: winner
                        ? "var(--accent)"
                        : "var(--line-strong)"
                    }}
                  />
                </span>
              </div>
            );
          })}
          {driver === "exhaust" ? (
            <div className="lc-cand winner">
              <div className="lc-cand-head">
                <span>Exhaust minimum</span>
                <span className="mono">{whole(load.designCfm)} CFM</span>
              </div>
              <span className="lc-bar-track">
                <span
                  className="lc-bar-fill"
                  style={{ width: "100%", background: "var(--accent)" }}
                />
              </span>
            </div>
          ) : null}
          <div className="lc-kv lc-cand-share">
            <span>Share of storey supply</span>
            <span className="mono">{percent(load.designCfm, totalDesignCfm)}</span>
          </div>
        </div>

        {/* Diagnostics */}
        {load.diagnostics.length > 0 ? (
          <div className="lc-bd-section">
            <div className="lc-bd-section-head">
              <span>Engine notes</span>
            </div>
            <ul className="lc-diag">
              {load.diagnostics.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </>
  );
}
