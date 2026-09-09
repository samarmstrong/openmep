// @vitest-environment jsdom

import type { PlanStorey } from "@openmep/model-core";
import { previewRoomAirflowChange } from "@openmep/model-core/design";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AirflowWorkbench } from "./airflow-workbench";

vi.mock("@openmep/model-core/design", () => ({ previewRoomAirflowChange: vi.fn() }));
vi.mock("./plan-canvas", () => ({
  PlanCanvas: ({ storey, highlightedItemIds }: { storey: PlanStorey; highlightedItemIds: string[] }) =>
    <output data-testid="canvas" data-highlights={highlightedItemIds.join(",")}>{storey.loads.totals.designCfm}</output>
}));

// The engine and canvas have independent geometry tests; this fixture supplies
// the state contract needed to exercise the workbench's transaction controls.
function fixture(units = "foot"): PlanStorey {
  return {
    name: "Test level", units,
    architecture: { spaces: [{ globalId: "room-a", label: "Office" }, { globalId: "room-b", label: "Meeting" }] },
    mechanicalEdit2D: ["room-a", "room-b"].map((spaceGlobalId) => ({ editKind: "node", kind: "mech-terminal", airflowType: "supply", spaceGlobalId })),
    loads: { spaces: [{ spaceGlobalId: "room-a", designCfm: 100 }, { spaceGlobalId: "room-b", designCfm: 200 }], totals: { designCfm: 300 } }
  } as PlanStorey;
}
function draft(value = 400) {
  fireEvent.change(screen.getByLabelText("New design airflow (CFM)"), { target: { value: String(value) } });
  fireEvent.click(screen.getByRole("button", { name: /Preview network change/ }));
}
function canvasCfm() { return screen.getByTestId("canvas").textContent; }
function apply() { fireEvent.click(screen.getByRole("button", { name: "Apply change" })); }

beforeEach(() => {
  vi.mocked(previewRoomAirflowChange).mockImplementation((storey, roomId, cfm) => {
    const old = storey.loads.spaces.find((room) => room.spaceGlobalId === roomId)!;
    return {
      storey: { ...storey, loads: { ...storey.loads, spaces: storey.loads.spaces.map((room) => room.spaceGlobalId === roomId ? { ...room, designCfm: cfm } : room), totals: { ...storey.loads.totals, designCfm: storey.loads.totals.designCfm - old.designCfm + cfm } } },
      terminalCount: 1, findings: [],
      changes: [{ itemId: "duct-a", elementRef: "supply-duct-a", beforeWidth: storey.units === "mm" ? 304.8 : 1, afterWidth: 1.5, beforeCfm: old.designCfm, afterCfm: cfm, diameterIn: 18 }]
    };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("AirflowWorkbench", () => {
  it("previews without committing, cancels, applies, undoes, and redoes", () => {
    const initial = fixture();
    render(<AirflowWorkbench initialStorey={initial} />);
    expect(canvasCfm()).toBe("300");
    draft();
    expect(canvasCfm()).toBe("600");
    expect(screen.getByTestId("canvas").getAttribute("data-highlights")).toBe("duct-a");
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(canvasCfm()).toBe("300");
    draft(); apply();
    expect(screen.queryByRole("button", { name: "Apply change" })).toBeNull();
    expect(canvasCfm()).toBe("600");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(canvasCfm()).toBe("300");
    expect((screen.getByLabelText("New design airflow (CFM)") as HTMLInputElement).value).toBe("100");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(canvasCfm()).toBe("600");
    expect(initial.loads.totals.designCfm).toBe(300);
  });

  it("invalidates a preview when airflow or room changes", () => {
    render(<AirflowWorkbench initialStorey={fixture()} />);
    draft();
    fireEvent.change(screen.getByLabelText("New design airflow (CFM)"), { target: { value: "500" } });
    expect(screen.queryByRole("button", { name: "Apply change" })).toBeNull();
    expect(canvasCfm()).toBe("300");
    draft();
    fireEvent.change(screen.getByLabelText("Room"), { target: { value: "room-b" } });
    expect(screen.queryByRole("button", { name: "Apply change" })).toBeNull();
    expect((screen.getByLabelText("New design airflow (CFM)") as HTMLInputElement).value).toBe("200");
  });

  it("discards the redo branch when a replacement change is applied", () => {
    render(<AirflowWorkbench initialStorey={fixture()} />);
    draft(); apply();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    draft(500); apply();
    expect(canvasCfm()).toBe("700");
    expect((screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("exports only committed state even while another preview is visible", () => {
    const blobs: string[] = [];
    vi.stubGlobal("Blob", class { constructor(parts: string[]) { blobs.push(parts.join("")); } });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<AirflowWorkbench initialStorey={fixture()} />);
    draft();
    fireEvent.click(screen.getByRole("button", { name: "Export applied JSON" }));
    expect(JSON.parse(blobs[0]!).loads.totals.designCfm).toBe(300);
    apply(); draft(700);
    fireEvent.click(screen.getByRole("button", { name: "Export applied JSON" }));
    expect(JSON.parse(blobs[1]!).loads.totals.designCfm).toBe(600);
  });

  it("shows engine validation failures without modifying the plan", () => {
    vi.mocked(previewRoomAirflowChange).mockImplementation(() => { throw new Error("No connected equipment path."); });
    render(<AirflowWorkbench initialStorey={fixture()} />);
    draft();
    expect(screen.getByRole("alert").textContent).toBe("No connected equipment path.");
    expect(canvasCfm()).toBe("300");
    expect(screen.queryByRole("button", { name: "Apply change" })).toBeNull();
  });

  it.each([["foot", "12″"], ["ft", "12″"], ["metre", "39.4″"], ["mm", "12″"]])("converts %s widths to inches", (unit, expected) => {
    render(<AirflowWorkbench initialStorey={fixture(unit)} />);
    draft();
    expect(screen.getByRole("cell", { name: `${expected} → 18″` })).toBeTruthy();
  });
});
