import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { IfcIndexRecord, ModelDiscipline, ModelSourceSummary } from "../types";
import { extractIfcIndex } from "../server/ifc";
import {
  buildCompositePlanModel,
  type CompositeProcessedSource
} from "../server/service";
import { validateMechanicalPlan } from "../server/hvac";

/**
 * Materialize the simplified 2D plan artifacts the agentic editor loop runs on.
 * Builds the composite plan from an ARCH + MECH IFC pair and writes, per storey,
 * the four artifact JSONs plus a baseline grade. The editor only ever touches
 * `mechanicalEdit2D.json`; everything else is read-only context.
 *
 *   tsx packages/model-core/src/scripts/eval-materialize.ts \
 *     --arch <ifc> --mech <ifc> [--out eval-runs] [--model-id eval-model]
 */

function arg(flag: string, fallback?: string): string {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) {
    return process.argv[i + 1];
  }
  if (fallback === undefined) {
    throw new Error(`${flag} <path> is required (see fixtures/README.md for the public IFC pairs).`);
  }
  return fallback;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "storey";
}

async function main(): Promise<void> {
  const archPath = arg("--arch");
  const mechPath = arg("--mech");
  const outRoot = arg("--out", "eval-runs");
  const modelId = arg("--model-id", "eval-model");

  const [archBytes, mechBytes] = await Promise.all([
    readFile(path.resolve(archPath)),
    readFile(path.resolve(mechPath))
  ]);
  const [archIndex, mechIndex] = await Promise.all([
    extractIfcIndex(new Uint8Array(archBytes), modelId),
    extractIfcIndex(new Uint8Array(mechBytes), modelId)
  ]);

  const now = new Date().toISOString();
  const summary = (
    sourceId: string,
    discipline: ModelDiscipline,
    name: string,
    index: IfcIndexRecord
  ): ModelSourceSummary => ({
    modelId,
    sourceId,
    discipline,
    name,
    status: "ready",
    schema: index.schema,
    sourceKey: `${sourceId}.ifc`,
    fragmentsKey: `${sourceId}.frag`,
    indexKey: `${sourceId}.json`,
    createdAt: now,
    updatedAt: now,
    counts: {
      storeys: index.storeys.length,
      spaces: index.spaces.length,
      elements: index.elements.length
    },
    fragmentsUrl: `/${sourceId}`,
    errorMessage: null
  });

  const sources: CompositeProcessedSource[] = [
    {
      summary: summary("architecture", "architecture", "ARCH", archIndex),
      bytes: new Uint8Array(archBytes),
      index: archIndex
    },
    {
      summary: summary("mechanical", "mechanical", "MECH", mechIndex),
      bytes: new Uint8Array(mechBytes),
      index: mechIndex
    }
  ];

  const plan = await buildCompositePlanModel(modelId, sources, {
    // Deterministic offline classification: this eval tests duct editing, not
    // space classification, so every space is treated as a general office.
    llmClassifier: async (spaces) =>
      new Map(spaces.map((space) => [space.globalId, "offices-commercial-general"]))
  });

  for (const storey of plan.storeys) {
    const dir = path.join(outRoot, modelId, safeName(storey.name));
    await mkdir(dir, { recursive: true });
    const report = validateMechanicalPlan({
      editItems: storey.mechanicalEdit2D,
      spaces: storey.architecture.spaces,
      spaceLoads: storey.loads.spaces
    });
    const write = (file: string, value: unknown) =>
      writeFile(path.join(dir, file), JSON.stringify(value, null, 2));
    await Promise.all([
      write("planStorey.json", storey),
      write("architecture.json", storey.architecture),
      write("loads.json", storey.loads),
      write("mechanicalVisual2D.json", storey.mechanicalVisual2D),
      write("mechanicalEdit2D.json", storey.mechanicalEdit2D),
      write("mechanicalEdit2D.baseline.json", storey.mechanicalEdit2D),
      write("baseline.json", report)
    ]);
    console.log(
      `${dir}  →  ${storey.mechanicalEdit2D.length} edit items, ` +
        `baseline ${report.errorCount}E/${report.warningCount}W`
    );
  }
  console.log(`\nmaterialized ${plan.storeys.length} storeys under ${path.join(outRoot, modelId)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
