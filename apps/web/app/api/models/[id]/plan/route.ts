import {
  getModelSummary,
  getPlanStorey,
  regeneratePlanModel
} from "@openmep/model-core/server";

import { errorResponse, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "cache-control": "no-store"
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const initialModel = await getModelSummary(id);
    if (!initialModel) {
      return errorResponse(404, `Model ${id} was not found.`);
    }
    const url = new URL(request.url);
    const readOnly = url.searchParams.get("readOnly") === "1";
    const regenerate = url.searchParams.get("regenerate") === "1";
    if (process.env.MEP_DEV_REGENERATE_PLAN_ON_REQUEST === "1" && regenerate && !readOnly) {
      await regeneratePlanModel(id);
    }

    const storeyId = url.searchParams.get("storeyId") ?? undefined;
    const requestedLayers = (url.searchParams.get("layers") ?? "")
      .split(",")
      .map((layer) => layer.trim())
      .filter(
        (
          layer
        ): layer is "architecture" | "mechanicalVisual2D" | "mechanicalEdit2D" | "loads" =>
          layer === "architecture" ||
          layer === "mechanicalVisual2D" ||
          layer === "mechanicalEdit2D" ||
          layer === "loads"
      );
    const storey = await getPlanStorey(
      id,
      storeyId,
      requestedLayers.length > 0 ? requestedLayers : undefined
    );
    if (storey) {
      return json(storey, { headers: noStoreHeaders });
    }

    const model = await getModelSummary(id);
    if (!model) {
      return errorResponse(404, `Model ${id} was not found.`);
    }

    if (model.planStatus !== "ready" || !model.planKey) {
      const message =
        model.planStatus === "failed"
          ? model.planErrorMessage ?? `Plan model for ${id} failed to generate.`
          : `Plan model for ${id} is not ready yet.`;
      return errorResponse(409, message);
    }

    return errorResponse(404, `Plan storey ${storeyId ?? "default"} was not found.`);
  } catch (error) {
    return errorResponse(
      500,
      error instanceof Error ? error.message : "Unable to fetch plan view."
    );
  }
}
