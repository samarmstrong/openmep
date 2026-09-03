import { readFile } from "node:fs/promises";
import path from "node:path";

import { getDbPool, query } from "../server/db";
import { createUploadModel, processModelIngestJob } from "../server/service";
import { publicFixturePath } from "../test/fixtures";

export const DEV_FIXTURE_MODEL_ID = "00000000-0000-4000-8000-000000000001";

// Public buildingSMART "Duplex Apartment" sample (CC BY 4.0): an IFC2x3 Revit
// ARCH + MEP pair with 1st-level IfcRelSpaceBoundary, so envelope conduction is
// active out of the box. `publicFixturePath` throws with the fetch command when
// the files have not been downloaded yet (fixtures/fetch-public-ifc.sh).
const architecturePath = publicFixturePath("duplex", "arc.ifc");
const mechanicalPath = publicFixturePath("duplex", "mep.ifc");

console.log(
  `Seeding public Duplex fixture from ${path.dirname(architecturePath)} ` +
    `(${path.basename(architecturePath)} + ${path.basename(mechanicalPath)}).`
);

const [architectureBytes, mechanicalBytes] = await Promise.all([
  readFile(architecturePath),
  readFile(mechanicalPath)
]);

await query(`delete from models where id = $1`, [DEV_FIXTURE_MODEL_ID]);

const model = await createUploadModel(
  {
    id: DEV_FIXTURE_MODEL_ID,
    name: "Dev fixture: buildingSMART Duplex Apartment ARCH + MEP",
    sources: [
      {
        sourceId: "architecture",
        discipline: "architecture",
        name: `duplex/${path.basename(architecturePath)}`,
        ifcBytes: architectureBytes
      },
      {
        sourceId: "mechanical",
        discipline: "mechanical",
        name: `duplex/${path.basename(mechanicalPath)}`,
        ifcBytes: mechanicalBytes
      }
    ]
  },
  { enqueue: false }
);

await processModelIngestJob({ modelId: model.id });
await getDbPool().end();

console.log(`Seeded dev fixture ${model.id}`);
console.log(`/models/${model.id}?mode=plan`);
