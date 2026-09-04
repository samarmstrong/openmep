import { getElementDetail, getModelSummary } from "@openmep/model-core/server";

import { errorResponse, json } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; globalId: string }> }
) {
  try {
    const { id, globalId } = await context.params;
    const model = await getModelSummary(id);
    if (!model) {
      return errorResponse(404, `Model ${id} was not found.`);
    }

    const detail = await getElementDetail(id, globalId);
    if (!detail) {
      return errorResponse(404, `Element ${globalId} was not found.`);
    }
    return json(detail);
  } catch (error) {
    return errorResponse(
      500,
      error instanceof Error ? error.message : "Unable to fetch element."
    );
  }
}
