// Shared helpers for experiment runners: fresh headless `claude -p` editors in isolated trial dirs.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cli = join(packageRoot, "bin", "mep-benchmark.js");

export function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => { const [key, value = "true"] = arg.replace(/^--/, "").split("="); return [key, value]; }));
}

export function positiveInteger(value, name, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer, got ${value}`);
  return parsed;
}

export const TOOL_CONTEXT = [
  "The benchmark's sizing engine is available as a command in the current directory:",
  "`./mep-benchmark size <cfm> <airflowType> <role>` prints JSON including `standardDiameterIn`.",
  "Use it whenever a duct must be sized.",
];

/** Creates an isolated trial directory holding only task.json, candidate.json, and (optionally) the sizing tool wrapper. */
export function prepareTrialDir(dir, { task, starter, tool }) {
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
  writeFileSync(join(dir, "candidate.json"), JSON.stringify(starter));
  if (tool) { writeFileSync(join(dir, "mep-benchmark"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`); chmodSync(join(dir, "mep-benchmark"), 0o755); }
}

export function runClaude(cwd, prompt, tools, { model, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env }; delete env.CLAUDECODE;
    const child = spawn("claude", ["-p", prompt, "--model", model, "--output-format", "json", "--dangerously-skip-permissions", "--no-session-persistence", "--tools", ...tools], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`editor timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`));
      let parsed; try { parsed = JSON.parse(stdout); } catch (error) { return reject(new Error(`unparseable claude output: ${error.message}\n${stdout.slice(0, 500)}`)); }
      if (parsed.is_error) return reject(new Error(`editor run failed: ${parsed.result}`));
      resolvePromise(parsed);
    });
  });
}

export function usedModels(run) {
  return Object.entries(run.modelUsage ?? {}).filter(([, usage]) => (usage.outputTokens ?? 0) > 0).map(([id]) => id);
}

export function describeFindings(result) {
  return [...result.current.errors, ...result.newErrors].map((f) => `${f.check}: ${f.itemId ?? f.spaceId} expected ${f.expected ?? ""} actual ${f.actual ?? ""}`.trim());
}

export async function runPool(items, concurrency, worker) {
  const queue = [...items]; const results = [];
  await Promise.all(Array.from({ length: concurrency }, async () => { while (queue.length) results.push(await worker(...queue.shift())); }));
  return results;
}
