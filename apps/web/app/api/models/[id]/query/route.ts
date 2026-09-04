import { getModelSummary, queryElements, queryRequestSchema } from "@openmep/model-core/server";
import { ZodError } from "zod";

import { errorResponse, json } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const model = await getModelSummary(id);
    if (!model) {
      return errorResponse(404, `Model ${id} was not found.`);
    }

    const payload = queryRequestSchema.parse(await request.json());
    const result = await queryElements(id, payload);
    return json(result);
  } catch (error) {
    return errorResponse(
      error instanceof ZodError ? 400 : 500,
      error instanceof Error ? error.message : "Unable to query model."
    );
  }
}
