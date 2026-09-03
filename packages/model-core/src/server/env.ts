import path from "node:path";

export type StorageDriver = "fs" | "s3";

export type ServerEnv = {
  databaseUrl: string;
  publicBaseUrl: string;
  storageDriver: StorageDriver;
  localStorageRoot: string | null;
  s3Endpoint: string | null;
  s3Region: string | null;
  s3Bucket: string | null;
  s3AccessKeyId: string | null;
  s3SecretAccessKey: string | null;
  pgBossSchema: string;
};

let cachedEnv: ServerEnv | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

export function getServerEnv(): ServerEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const storageDriver = required("STORAGE_DRIVER");
  if (storageDriver !== "fs" && storageDriver !== "s3") {
    throw new Error("STORAGE_DRIVER must be either 'fs' or 's3'.");
  }

  const env: ServerEnv = {
    databaseUrl: required("DATABASE_URL"),
    publicBaseUrl: required("PUBLIC_BASE_URL"),
    storageDriver,
    localStorageRoot:
      storageDriver === "fs"
        ? path.resolve(required("LOCAL_STORAGE_ROOT"))
        : null,
    s3Endpoint: storageDriver === "s3" ? required("S3_ENDPOINT") : null,
    s3Region: storageDriver === "s3" ? required("S3_REGION") : null,
    s3Bucket: storageDriver === "s3" ? required("S3_BUCKET") : null,
    s3AccessKeyId:
      storageDriver === "s3" ? required("S3_ACCESS_KEY_ID") : null,
    s3SecretAccessKey:
      storageDriver === "s3" ? required("S3_SECRET_ACCESS_KEY") : null,
    pgBossSchema: process.env.PG_BOSS_SCHEMA ?? "pgboss"
  };

  cachedEnv = env;
  return env;
}
