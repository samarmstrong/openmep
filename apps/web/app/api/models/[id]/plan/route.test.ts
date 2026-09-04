import { beforeEach, describe, expect, it, vi } from "vitest";

const { getModelSummary, getPlanStorey, regeneratePlanModel } = vi.hoisted(() => ({
  getModelSummary: vi.fn(),
  getPlanStorey: vi.fn(),
  regeneratePlanModel: vi.fn()
}));

vi.mock("@openmep/model-core/server", () => ({
  getModelSummary,
  getPlanStorey,
  regeneratePlanModel
}));

import { GET } from "./route";

describe("GET /api/models/[id]/plan", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns a plan storey when the plan artifact is ready", async () => {
    getModelSummary.mockResolvedValue({
      id: "model-1",
      planStatus: "ready",
      planKey: "models/model-1/plan.json"
    });
    getPlanStorey.mockResolvedValue({
      globalId: "storey-1",
      name: "Level 1"
    });

    const response = await GET(
      new Request("http://localhost/api/models/model-1/plan?storeyId=storey-1"),
      {
        params: Promise.resolve({ id: "model-1" })
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      globalId: "storey-1",
      name: "Level 1"
    });
    expect(getPlanStorey).toHaveBeenCalledWith("model-1", "storey-1", undefined);
  });

  it("regenerates on explicit request when dev regeneration is enabled", async () => {
    vi.stubEnv("MEP_DEV_REGENERATE_PLAN_ON_REQUEST", "1");
    getModelSummary.mockResolvedValue({
      id: "model-1",
      planStatus: "ready",
      planKey: "models/model-1/plan.json"
    });
    regeneratePlanModel.mockResolvedValue(undefined);
    getPlanStorey.mockResolvedValue({
      globalId: "storey-1",
      name: "Level 1"
    });

    const response = await GET(
      new Request("http://localhost/api/models/model-1/plan?regenerate=1"),
      {
        params: Promise.resolve({ id: "model-1" })
      }
    );

    expect(response.status).toBe(200);
    expect(regeneratePlanModel).toHaveBeenCalledWith("model-1");
  });

  it("skips dev regeneration for normal plan requests", async () => {
    vi.stubEnv("MEP_DEV_REGENERATE_PLAN_ON_REQUEST", "1");
    getModelSummary.mockResolvedValue({
      id: "model-1",
      planStatus: "ready",
      planKey: "models/model-1/plan.json"
    });
    getPlanStorey.mockResolvedValue({
      globalId: "storey-1",
      name: "Level 1"
    });

    const response = await GET(new Request("http://localhost/api/models/model-1/plan"), {
      params: Promise.resolve({ id: "model-1" })
    });

    expect(response.status).toBe(200);
    expect(regeneratePlanModel).not.toHaveBeenCalled();
  });

  it("skips dev regeneration for read-only plan requests", async () => {
    vi.stubEnv("MEP_DEV_REGENERATE_PLAN_ON_REQUEST", "1");
    getModelSummary.mockResolvedValue({
      id: "model-1",
      planStatus: "ready",
      planKey: "models/model-1/plan.json"
    });
    getPlanStorey.mockResolvedValue({
      globalId: "storey-1",
      name: "Level 1"
    });

    const response = await GET(
      new Request("http://localhost/api/models/model-1/plan?readOnly=1"),
      {
        params: Promise.resolve({ id: "model-1" })
      }
    );

    expect(response.status).toBe(200);
    expect(regeneratePlanModel).not.toHaveBeenCalled();
  });

  it("returns a plan storey when a fallback artifact can still be read", async () => {
    getModelSummary.mockResolvedValue({
      id: "model-1",
      planStatus: "failed",
      planKey: null,
      planErrorMessage: "Plan regeneration failed."
    });
    getPlanStorey.mockResolvedValue({
      globalId: "storey-1",
      name: "Level 1"
    });

    const response = await GET(
      new Request("http://localhost/api/models/model-1/plan?storeyId=storey-1"),
      {
        params: Promise.resolve({ id: "model-1" })
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      globalId: "storey-1",
      name: "Level 1"
    });
  });

  it("returns 409 while the plan model is still processing", async () => {
    getModelSummary.mockResolvedValue({
      id: "model-1",
      planStatus: "processing",
      planKey: null,
      planErrorMessage: null
    });
    getPlanStorey.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/models/model-1/plan"), {
      params: Promise.resolve({ id: "model-1" })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Plan model for model-1 is not ready yet."
    });
  });

  it("returns 409 with the plan extraction error when the plan model failed", async () => {
    getModelSummary.mockResolvedValue({
      id: "model-1",
      planStatus: "failed",
      planKey: null,
      planErrorMessage: "IfcSpace geometry was missing."
    });
    getPlanStorey.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/models/model-1/plan"), {
      params: Promise.resolve({ id: "model-1" })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "IfcSpace geometry was missing."
    });
  });

  it("returns 409 when a stale plan is rebuilding after version validation", async () => {
    getModelSummary
      .mockResolvedValueOnce({
        id: "model-1",
        planStatus: "ready",
        planKey: "models/model-1/plan.json",
        planErrorMessage: null
      })
      .mockResolvedValueOnce({
        id: "model-1",
        planStatus: "processing",
        planKey: null,
        planErrorMessage: null
      });
    getPlanStorey.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/models/model-1/plan"), {
      params: Promise.resolve({ id: "model-1" })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Plan model for model-1 is not ready yet."
    });
  });
});
