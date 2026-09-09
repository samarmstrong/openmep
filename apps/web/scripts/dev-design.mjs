import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = path.join(root, "apps/web");
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
run("npm", ["run", "build", "--workspace", "@openmep/hvac-domain"]);
if (refresh || !existsSync(path.join(root, "eval-runs/wbdg_office/Level_1/planStorey.json"))) {
  run("bash", ["fixtures/fetch-public-ifc.sh", "wbdg_office"]);
  const fixtures = path.resolve(root, process.env.IFC_FIXTURE_DIR ?? "fixtures/public");
  run(process.execPath, ["node_modules/tsx/dist/cli.mjs", "packages/model-core/src/scripts/eval-materialize.ts",
    "--arch", path.join(fixtures, "wbdg_office/arc.ifc"), "--mech", path.join(fixtures, "wbdg_office/mep.ifc"), "--model-id", "wbdg_office"]);
}
const nextArgs = args.filter((arg) => arg !== "--refresh");
if (!nextArgs.includes("--port") && !nextArgs.includes("-p")) nextArgs.push("--port", process.env.PORT ?? "3001");
console.log("Open /design to change room airflow in the public Office plan.");
const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", ...nextArgs], {
  cwd: web, stdio: "inherit", env: process.env
});
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0); });
