import { getModelSummary, getStorageAdapter } from "@mep/model-core/server";

import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; sourceId: string }> }
) {
  try {
    const { id, sourceId } = await context.params;
    const model = await getModelSummary(id);
    if (!model) {
      return errorResponse(404, `Model ${id} was not found.`);
    }

    const source = model.sources.find((candidate) => candidate.sourceId === sourceId) ?? null;
    if (!source) {
      return errorResponse(404, `Source ${sourceId} was not found for model ${id}.`);
    }
    if (!source.fragmentsKey) {
      return errorResponse(409, `Source ${sourceId} does not have fragments yet.`);
    }

    const object = await getStorageAdapter().getObject(source.fragmentsKey);
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
