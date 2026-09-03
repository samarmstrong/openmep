import { getModelSummary, getStorageAdapter } from "@mep/model-core/server";

import { errorResponse } from "@/lib/http";

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
    const source =
      model.sources.find((candidate) => candidate.discipline === "architecture") ??
      model.sources[0] ??
      null;
    const fragmentsKey = model.fragmentsKey ?? source?.fragmentsKey ?? null;
    if (!fragmentsKey) {
      return errorResponse(409, `Model ${id} does not have fragments yet.`);
    }

    const object = await getStorageAdapter().getObject(fragmentsKey);
    return new Response(new Uint8Array(object.body), {
      status: 200,
      headers: {
        "content-type": object.contentType,
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return errorResponse(
      500,
      error instanceof Error ? error.message : "Unable to stream fragments."
    );
  }
}
