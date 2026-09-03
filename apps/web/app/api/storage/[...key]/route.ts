import { getStorageAdapter } from "@mep/model-core/server";

import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string[] }> }
) {
  try {
    const { key } = await context.params;
    const object = await getStorageAdapter().getObject(key.join("/"));
    return new Response(new Uint8Array(object.body), {
      headers: {
        "content-type": object.contentType,
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return errorResponse(
      500,
      error instanceof Error ? error.message : "Unable to read storage object."
    );
  }
}
