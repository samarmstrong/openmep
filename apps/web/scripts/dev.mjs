import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const hasPort = args.includes("--port");
const nextArgs = ["../../node_modules/next/dist/bin/next", "dev"];
const skipFixture = process.env.MEP_SKIP_DEV_FIXTURE === "1";

if (!skipFixture) {
  const seed = spawnSync(
    process.execPath,
    [
      "../../node_modules/tsx/dist/cli.mjs",
      "../../packages/model-core/src/scripts/seed-dev-fixture.ts"
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit"
    }
  );

  if (seed.error) {
    throw seed.error;
  }

  if (seed.status !== 0) {
    process.exit(seed.status ?? 1);
  }
}

process.env.MEP_DEV_REGENERATE_PLAN_ON_REQUEST ??= "0";

if (!hasPort) {
  nextArgs.push("--port", process.env.PORT ?? "3001");
}

nextArgs.push(...args);

const child = spawn(process.execPath, nextArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
