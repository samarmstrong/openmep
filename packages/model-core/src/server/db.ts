import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow
} from "pg";

import { getServerEnv } from "./env";

let cachedPool: Pool | null = null;

export function getDbPool(): Pool {
  if (!cachedPool) {
    cachedPool = new Pool({
      connectionString: getServerEnv().databaseUrl
    });
  }
  return cachedPool;
}

export async function withDbTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runSqlFile(filename: string): Promise<void> {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const sqlPath = path.resolve(
    currentDirectory,
    "../../sql",
    filename
  );
  const statement = await readFile(sqlPath, "utf8");
  await getDbPool().query(statement);
}

export async function query<T extends QueryResultRow>(
  text: string,
  values: unknown[] = [],
  client?: PoolClient
): Promise<QueryResult<T>> {
  if (client) {
    return client.query<T>(text, values);
  }
  return getDbPool().query<T>(text, values);
}
