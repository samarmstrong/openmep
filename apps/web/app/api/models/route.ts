import { createUploadModel, listModels } from "@mep/model-core/server";

import { errorResponse, json } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const models = await listModels();
    return json({ items: models });
  } catch (error) {
    return errorResponse(
      500,
      error instanceof Error ? error.message : "Unable to list models."
    );
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const legacyFile = formData.get("file");
    const architectureFile = formData.get("architectureFile");
    const mechanicalFile = formData.get("mechanicalFile");

    const files = [
      legacyFile instanceof File
        ? {
            sourceId: "architecture",
            discipline: "architecture" as const,
            name: legacyFile.name,
            file: legacyFile
          }
        : null,
      architectureFile instanceof File
        ? {
            sourceId: "architecture",
            discipline: "architecture" as const,
            name: architectureFile.name,
            file: architectureFile
          }
        : null,
      mechanicalFile instanceof File
        ? {
            sourceId: "mechanical",
            discipline: "mechanical" as const,
            name: mechanicalFile.name,
            file: mechanicalFile
          }
        : null
    ].filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

    if (files.length === 0) {
      return errorResponse(
        400,
        "Expected a multipart file field named 'file' or 'architectureFile'."
      );
    }

    if (files.some(({ file }) => !file.name.toLowerCase().endsWith(".ifc"))) {
      return errorResponse(400, "Only IFC uploads are supported.");
    }

    const model = await createUploadModel({
      name:
        files.length > 1
          ? `${files[0].name} + overlay`
          : files[0].name,
      sources: await Promise.all(
        files.map(async ({ sourceId, discipline, name, file }) => ({
          sourceId,
          discipline,
          name,
          ifcBytes: Buffer.from(await file.arrayBuffer())
        }))
      )
    });

    return json(model, { status: 201 });
  } catch (error) {
    return errorResponse(
      500,
      error instanceof Error ? error.message : "Unable to create model."
    );
  }
}
