import { getModelSummary } from "@mep/model-core/server";

import { errorResponse, json } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const model = await getModelSummary(id);
    if (!model) {
      return errorResponse(404, `Model ${id} was not found.`);
    }
    return json(model);
  } catch (error) {
    return errorResponse(
      500,
      error instanceof Error ? error.message : "Unable to fetch model."
    );
  }
}
