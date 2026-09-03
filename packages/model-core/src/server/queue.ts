import { PgBoss } from "pg-boss";

import type { IngestJobPayload } from "../types";
import { ingestJobPayloadSchema } from "../types";
import { getServerEnv } from "./env";

export const MODEL_INGEST_QUEUE = "model-ingest";

let cachedBoss: PgBoss | null = null;
let started = false;

export async function getBoss(): Promise<PgBoss> {
  if (!cachedBoss) {
    const env = getServerEnv();
    cachedBoss = new PgBoss({
      connectionString: env.databaseUrl,
      schema: env.pgBossSchema
    });
    cachedBoss.on("error", (error) => {
      console.error("pg-boss error", error);
    });
  }

  if (!started) {
    await cachedBoss.start();
    await cachedBoss.createQueue(MODEL_INGEST_QUEUE);
    started = true;
  }

  return cachedBoss;
}

export async function enqueueModelIngestJob(payload: IngestJobPayload) {
  const parsed = ingestJobPayloadSchema.parse(payload);
  const boss = await getBoss();
  return boss.send(MODEL_INGEST_QUEUE, parsed);
}
