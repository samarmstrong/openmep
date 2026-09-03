import { describe, expect, it } from "vitest";

import { errorResponse, json } from "./http";

describe("http helpers", () => {
  it("creates json responses", async () => {
    const response = json({ ok: true }, { status: 201 });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("creates error responses", async () => {
    const response = errorResponse(400, "Bad request");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Bad request" });
  });
});
