import {
  getBoss,
  ingestJobPayloadSchema,
  MODEL_INGEST_QUEUE,
  processModelIngestJob
} from "@openmep/model-core/server";

const boss = await getBoss();

await boss.work(
  MODEL_INGEST_QUEUE,
  { pollingIntervalSeconds: 2, batchSize: 1 },
  async ([job]) => {
    await processModelIngestJob(ingestJobPayloadSchema.parse(job.data));
  }
);

console.log(`Worker subscribed to ${MODEL_INGEST_QUEUE}.`);
