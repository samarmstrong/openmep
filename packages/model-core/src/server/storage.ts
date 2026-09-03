import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

import { getServerEnv } from "./env";

export type StoredObject = {
  body: Buffer;
  contentType: string;
};

export interface StorageAdapter {
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<StoredObject>;
  buildUrl(key: string): string;
}

class FileSystemStorageAdapter implements StorageAdapter {
  constructor(private readonly root: string, private readonly publicBaseUrl: string) {}

  async putObject(
    key: string,
    body: Buffer,
    contentType: string
  ): Promise<void> {
    const fullPath = path.join(this.root, key);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, body);
    await writeFile(`${fullPath}.content-type`, contentType, "utf8");
  }

  async getObject(key: string): Promise<StoredObject> {
    const fullPath = path.join(this.root, key);
    const [body, contentType] = await Promise.all([
      readFile(fullPath),
      readFile(`${fullPath}.content-type`, "utf8")
    ]);

    return {
      body,
      contentType
    };
  }

  buildUrl(key: string): string {
    const encoded = key
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    return `${this.publicBaseUrl}/api/storage/${encoded}`;
  }
}

class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly endpoint: string,
    private readonly publicBaseUrl: string,
    region: string,
    accessKeyId: string,
    secretAccessKey: string
  ) {
    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    });
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType
      })
    );
  }

  async getObject(key: string): Promise<StoredObject> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      })
    );

    if (!response.Body) {
      throw new Error(`Storage object ${key} was empty.`);
    }

    const body = Buffer.from(await response.Body.transformToByteArray());
    return {
      body,
      contentType: response.ContentType ?? "application/octet-stream"
    };
  }

  buildUrl(key: string): string {
    const encoded = key
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    return `${this.publicBaseUrl}/api/storage/${encoded}`;
  }
}

let cachedStorage: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
  if (cachedStorage) {
    return cachedStorage;
  }

  const env = getServerEnv();

  if (env.storageDriver === "fs") {
    if (!env.localStorageRoot) {
      throw new Error("LOCAL_STORAGE_ROOT is required when STORAGE_DRIVER=fs.");
    }
    cachedStorage = new FileSystemStorageAdapter(
      env.localStorageRoot,
      env.publicBaseUrl
    );
    return cachedStorage;
  }

  if (
    !env.s3Bucket ||
    !env.s3Endpoint ||
    !env.s3Region ||
    !env.s3AccessKeyId ||
    !env.s3SecretAccessKey
  ) {
    throw new Error("S3 storage is configured but one or more S3 variables are missing.");
  }

  cachedStorage = new S3StorageAdapter(
    env.s3Bucket,
    env.s3Endpoint,
    env.publicBaseUrl,
    env.s3Region,
    env.s3AccessKeyId,
    env.s3SecretAccessKey
  );
  return cachedStorage;
}
