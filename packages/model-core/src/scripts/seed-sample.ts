import { readFile } from "node:fs/promises";
import path from "node:path";

import { createUploadModel, processModelIngestJob } from "../server/service";
import { publicFixturePath } from "../test/fixtures";

// Seed a single-discipline model from an IFC path, defaulting to the public
// buildingSMART Duplex ARCH fixture (fixtures/fetch-public-ifc.sh duplex).
const samplePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : publicFixturePath("duplex", "arc.ifc");

const bytes = await readFile(samplePath);
const model = await createUploadModel({
  name: path.basename(samplePath),
  ifcBytes: bytes
}, { enqueue: false });

await processModelIngestJob({ modelId: model.id });

console.log(`Seeded model ${model.id} from ${samplePath}`);
