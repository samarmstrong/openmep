"use client";

import type { PlanStorey } from "@openmep/model-core";
import { previewRoomAirflowChange } from "@openmep/model-core/design";
import { useMemo, useState } from "react";
import { ArrowDownToLine, ArrowRight, Check, Redo2, Undo2, Wind } from "lucide-react";
import { PlanCanvas } from "./plan-canvas";
import styles from "./airflow-workbench.module.css";

type Preview = ReturnType<typeof previewRoomAirflowChange>;
type Snapshot = { storey: PlanStorey; highlights: string[] };
const inchesPerUnit = (units: string): number | null => {
  switch (units.trim().toLowerCase()) {
    case "ft": case "foot": case "feet": return 12;
    case "m": case "metre": case "metres": case "meter": case "meters": return 1 / 0.0254;
    case "mm": case "millimetre": case "millimetres": case "millimeter": case "millimeters": return 1 / 25.4;
    default: return null;
  }
};
const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });

export function AirflowWorkbench({ initialStorey }: { initialStorey: PlanStorey }) {
  const [history, setHistory] = useState<Snapshot[]>([{ storey: initialStorey, highlights: [] }]);
  const [cursor, setCursor] = useState(0);
  const committed = history[cursor]!;
  const rooms = useMemo(() => committed.storey.architecture.spaces.filter((room) =>
    committed.storey.mechanicalEdit2D.some((item) => item.editKind === "node" && item.kind === "mech-terminal" && item.airflowType === "supply" && item.spaceGlobalId === room.globalId)
  ), [committed.storey]);
  const [roomId, setRoomId] = useState(() => initialStorey.architecture.spaces.find((room) =>
    initialStorey.mechanicalEdit2D.some((item) => item.editKind === "node" && item.kind === "mech-terminal" && item.airflowType === "supply" && item.spaceGlobalId === room.globalId)
  )?.globalId ?? "");
  const roomLoad = committed.storey.loads.spaces.find((room) => room.spaceGlobalId === roomId);
  const [input, setInput] = useState(() => String(initialStorey.loads.spaces.find((room) => room.spaceGlobalId === roomId)?.designCfm ?? ""));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const displayed = preview?.storey ?? committed.storey;
  const highlights = preview ? preview.changes.map((change) => change.itemId) : committed.highlights;
  const terminalCount = committed.storey.mechanicalEdit2D.filter((item) => item.editKind === "node" && item.kind === "mech-terminal" && item.airflowType === "supply" && item.spaceGlobalId === roomId).length;
  const validInput = input.trim() !== "" && Number.isFinite(Number(input)) && Number(input) > 0;
  const clearDraft = () => { setPreview(null); setError(null); setNotice(""); };
  const selectRoom = (id: string) => {
    if (!rooms.some((room) => room.globalId === id)) return;
    setRoomId(id);
    setInput(String(committed.storey.loads.spaces.find((room) => room.spaceGlobalId === id)?.designCfm ?? ""));
    clearDraft();
  };
  const moveHistory = (next: number) => {
    setCursor(next);
    setInput(String(history[next]!.storey.loads.spaces.find((room) => room.spaceGlobalId === roomId)?.designCfm ?? ""));
    clearDraft();
    setNotice(next < cursor ? "Change undone." : "Change restored.");
  };
  const createPreview = () => {
    clearDraft();
    if (!validInput) { setError("Enter an airflow greater than zero."); return; }
    try { setPreview(previewRoomAirflowChange(committed.storey, roomId, Number(input))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to preview this change."); }
  };
  const apply = () => {
    if (!preview) return;
    setHistory([...history.slice(0, cursor + 1), { storey: preview.storey, highlights: preview.changes.map((change) => change.itemId) }]);
    setCursor(cursor + 1);
    setPreview(null);
    setNotice("Applied to this session. Export to keep your design.");
  };
  const download = () => {
    const blob = new Blob([JSON.stringify(committed.storey, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${committed.storey.name.replace(/[^a-z0-9_-]+/gi, "-")}-airflow-design.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Exported the applied design as JSON.");
  };
  const conversion = inchesPerUnit(displayed.units);
  const inches = (width: number | null) => width === null || conversion === null ? "—" : `${number(width * conversion)}″`;

  return <main className={styles.workbench}>
    <header className={styles.header}>
      <div className={styles.brand}><span className={styles.mark}><Wind size={22} /></span><div><p className={styles.eyebrow}>OPENMEP / DESIGN STUDIO</p><h1>Airflow design</h1></div></div>
      <div className={styles.actions}>
        <button type="button" aria-label="Undo" disabled={cursor === 0} onClick={() => moveHistory(cursor - 1)}><Undo2 size={16} />Undo</button>
        <button type="button" aria-label="Redo" disabled={cursor === history.length - 1} onClick={() => moveHistory(cursor + 1)}><Redo2 size={16} />Redo</button>
        <button type="button" onClick={download}><ArrowDownToLine size={16} />Export applied JSON</button>
      </div>
    </header>
    <div className={styles.intro}><div><p className={styles.eyebrow}>{initialStorey.name}</p><h2>Edit a room. Update its supply network.</h2><p>Preview airflow and round duct sizes across connected supply ducts.</p></div><span className={styles.session}>SESSION DESIGN · {cursor} applied {cursor === 1 ? "change" : "changes"}</span></div>
    <div className={styles.layout}>
      <section className={styles.canvasPanel} aria-label="Supply network plan">
        <div className={styles.canvasHeading}><div><span className={styles.dot} />{preview ? "CHANGE PREVIEW" : "APPLIED DESIGN"}</div><span>{number(displayed.loads.totals.designCfm)} CFM total</span></div>
        <div className={styles.canvas}><PlanCanvas storey={displayed} showArchitecture showMechanical showMechanicalEditOverlay selectedGlobalId={roomId || null} selectedSpaceId={roomId || null} highlightedItemIds={highlights} frameSelection={false} renderDuctWidths onSelect={(item) => { if (item.kind === "space") selectRoom(item.globalId); }} /></div>
        <div className={styles.legend}><span><i />{preview ? "Proposed" : "Applied"} duct sizes</span><span>Imported geometry stays visible for context</span><span>Scroll to zoom · drag to pan</span></div>
      </section>
      <aside className={styles.panel}>
        <p className={styles.eyebrow}>01 / ROOM AIRFLOW</p><h3>Set the design airflow</h3>
        <label htmlFor="airflow-room">Room</label><select id="airflow-room" value={roomId} onChange={(event) => selectRoom(event.target.value)}>{rooms.length === 0 && <option value="">No rooms with supply terminals</option>}{rooms.map((room) => <option key={room.globalId} value={room.globalId}>{room.label}{room.secondaryLabel ? ` · ${room.secondaryLabel}` : ""}</option>)}</select>
        <div className={styles.metrics}><div><span>Applied airflow</span><strong>{number(roomLoad?.designCfm ?? 0)} <small>CFM</small></strong></div><div><span>Supply terminals</span><strong>{terminalCount}</strong></div></div>
        <form onSubmit={(event) => { event.preventDefault(); createPreview(); }}><label htmlFor="design-airflow">New design airflow (CFM)</label><input id="design-airflow" type="number" min="0.1" step="any" value={input} onChange={(event) => { setInput(event.target.value); clearDraft(); }} disabled={!roomId} /><p className={styles.help}>Manual airflow override. Distributed equally across this room’s supply terminals.</p><button className={styles.primary} type="submit" disabled={!roomId || !validInput}>Preview network change <ArrowRight size={16} /></button></form>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {preview ? <section className={styles.preview} aria-label="Change preview"><p className={styles.eyebrow}>02 / REVIEW CHANGES</p><h3>{preview.changes.length} affected {preview.changes.length === 1 ? "duct" : "ducts"}</h3><p>{number(Number(input) / preview.terminalCount)} CFM per terminal · {preview.terminalCount} terminals</p>
          <div className={styles.tableWrap}><table><thead><tr><th>Duct</th><th>CFM</th><th>Size → round Ø</th></tr></thead><tbody>{preview.changes.map((change, index) => <tr key={change.itemId}><td title={change.elementRef}>Duct {index + 1}<small>{change.elementRef.slice(-10)}</small></td><td>{number(change.beforeCfm)} → <b>{number(change.afterCfm)}</b></td><td>{inches(change.beforeWidth)} → <b>{number(change.diameterIn)}″</b></td></tr>)}</tbody></table></div>
          <p className={styles.help}>Existing width → proposed round diameter. Review before applying.</p>
          {preview.findings.length > 0 && <details className={styles.findings}><summary>Network notes ({preview.findings.length})</summary><ul>{preview.findings.map((finding, index) => <li key={index}>{typeof finding === "string" ? finding : "message" in finding ? String(finding.message) : JSON.stringify(finding)}</li>)}</ul></details>}
          <div className={styles.previewActions}><button className={styles.primary} type="button" onClick={apply}><Check size={16} />Apply change</button><button type="button" onClick={clearDraft}>Cancel</button></div></section> : <div className={styles.emptyPreview}><Wind size={24} /><p>Choose a room and preview a new airflow to see how its supply network changes.</p></div>}
        <p className={styles.notice} role="status">{notice}</p><p className={styles.footnote}>Changes stay in this session. Export saves the applied plan; uncommitted previews are excluded.</p>
      </aside>
    </div>
  </main>;
}
