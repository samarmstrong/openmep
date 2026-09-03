import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Serves the @thatopen/fragments Web Worker script.
 * We walk up from this file to the monorepo root's node_modules.
 */
export async function GET() {
  try {
    // In the npm-workspaces monorepo the package is hoisted to the root node_modules.
    // __dirname equivalent is unreliable inside Next.js bundled routes, so we
    // walk up from cwd() parents until we find the hoisted package.
    let dir = process.cwd();
    let workerPath: string | null = null;

    for (let i = 0; i < 5; i++) {
      const candidate = path.join(
        dir,
        "node_modules/@thatopen/fragments/dist/Worker/worker.mjs"
      );
      try {
        await readFile(candidate, { flag: "r" });
        workerPath = candidate;
        break;
      } catch {
        dir = path.dirname(dir);
      }
    }

    if (!workerPath) {
      throw new Error(
        "Could not locate @thatopen/fragments worker.mjs in any ancestor node_modules."
      );
    }

    const body = await readFile(workerPath, "utf8");
    return new Response(body, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable"
      }
    });
  } catch (error) {
    return errorResponse(
      500,
      error instanceof Error ? error.message : "Unable to load fragments worker."
    );
  }
}
