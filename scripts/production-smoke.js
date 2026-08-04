import { spawn } from "node:child_process";

const port = 18000 + (process.pid % 10000);
const expectedVersion = "0.12.1";
const expectedModel = "gpt-5-mini-2025-08-07";
const child = spawn(process.execPath, ["src/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "smoke-test-key-not-used",
    OPENAI_MODEL: expectedModel,
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    CAMPAIGN_STORE: "supabase",
    AUTH_REQUIRED: "true",
    SUPABASE_URL: "https://smoke-test.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_smoke_test",
    CORS_ORIGIN: "https://desktop.khaos-nexus.invalid",
    TRUST_PROXY: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Production process exited early (${child.exitCode}).\n${stderr}\n${stdout}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Origin: "https://desktop.khaos-nexus.invalid" },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return response.json();
    } catch {
      // The process may still be starting.
    }
    await sleep(100);
  }
  throw new Error(`Production health check timed out.\n${stderr}\n${stdout}`);
}

try {
  const health = await waitForHealth();
  if (health.status !== "ok") throw new Error("Health status was not ok");
  if (health.version !== expectedVersion) {
    throw new Error(`Expected version ${expectedVersion}, received ${health.version}`);
  }
  if (health.provider !== "openai" || health.model !== expectedModel) {
    throw new Error("Pinned production provider/model configuration was not active");
  }
  if (health.store !== "supabase" || health.authentication !== "required") {
    throw new Error("Production persistence/authentication configuration was not active");
  }
  if (health.productionControls?.enabled !== true) {
    throw new Error("Production controls were not enabled");
  }
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

if (child.exitCode !== 0 && child.signalCode !== "SIGTERM") {
  throw new Error(`Production smoke process did not shut down cleanly.\n${stderr}\n${stdout}`);
}
console.log("Production startup and pinned-model health smoke passed");
