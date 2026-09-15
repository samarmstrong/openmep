import { describe, expect, it } from "vitest";
import { PortGraphError, connectCoincidentPorts, type PortRef } from "./port-graph.js";

const port = (itemRef: string, position: [number, number, number], system?: string): PortRef => ({ itemRef, position, system });

describe("connectCoincidentPorts", () => {
  it("connects items whose ports fall within the tolerance and lists every item", () => {
    const graph = connectCoincidentPorts([
      port("EQ", [0, 1.1, 0], "supply"),
      port("MAIN", [0, 1.1, 0.03], "supply"),
      port("MAIN", [4, 2.6, 0], "supply"),
      port("RUN", [4, 2.6, 0.049], "supply"),
      port("FAR", [20, 0, 0], "supply"),
    ]);
    expect([...graph.keys()]).toEqual(["EQ", "FAR", "MAIN", "RUN"]);
    expect(graph.get("MAIN")).toEqual(["EQ", "RUN"]);
    expect(graph.get("RUN")).toEqual(["MAIN"]);
    expect(graph.get("FAR")).toEqual([]);
  });
  it("never connects an item to itself and separates incompatible systems", () => {
    const graph = connectCoincidentPorts([
      port("LOOP", [0, 0, 0], "supply"),
      port("LOOP", [0, 0, 0], "supply"),
      port("RETURN", [0, 0, 0], "return"),
      port("UNTAGGED", [0, 0, 0]),
    ]);
    expect(graph.get("LOOP")).toEqual(["UNTAGGED"]);
    expect(graph.get("RETURN")).toEqual(["UNTAGGED"]);
    expect(graph.get("UNTAGGED")).toEqual(["LOOP", "RETURN"]);
  });
  it("honours a custom tolerance", () => {
    const ports = [port("A", [0, 0, 0]), port("B", [0.2, 0, 0])];
    expect(connectCoincidentPorts(ports).get("A")).toEqual([]);
    expect(connectCoincidentPorts(ports, { toleranceM: 0.25 }).get("A")).toEqual(["B"]);
  });
  it("throws typed errors for invalid tolerance and positions", () => {
    expect(() => connectCoincidentPorts([], { toleranceM: -1 })).toThrow(expect.objectContaining({ code: "invalid-tolerance" }));
    expect(() => connectCoincidentPorts([port("A", [0, Number.NaN, 0])])).toThrow(PortGraphError);
  });
});
