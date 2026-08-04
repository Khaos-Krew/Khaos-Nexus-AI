import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexUrl = new URL("../src/index.js", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const manifestUrl = new URL("../integrations/khaos-nexus/integration-manifest.json", import.meta.url);

test("runtime attaches the desktop Co-DM contract and launch security boundary", async () => {
  const content = await readFile(indexUrl, "utf8");
  assert.match(content, /const SERVICE_VERSION = "0\.12\.1"/);
  assert.match(content, /loadRuntimeConfig\(process\.env\)/);
  assert.match(content, /withCoDmDraft\(withSessionIntelligence\(new MockAiProvider\(\)\)\)/);
  assert.match(content, /withSessionIntelligenceStore\(/);
  assert.match(content, /withRetrievalStore\(/);
  assert.match(content, /withMapSceneStore\(/);
  assert.match(content, /withProductionControlStore\(/);
  assert.match(content, /withLaunchControlStore\(/);
  assert.match(content, /withProductionControls\(baseProvider, persistence\.store\)/);
  assert.match(content, /withSafeProviderErrors\(/);
  assert.match(content, /SafeSupabaseAuthVerifier/);
  assert.match(content, /SafeSupabaseRestClient/);
  assert.match(content, /attachCoDmRoutes\(server/);
  assert.match(content, /attachSessionIntelligenceRoutes\(server/);
  assert.match(content, /attachRetrievalRoutes\(server/);
  assert.match(content, /attachMapSceneRoutes\(server/);
  assert.match(content, /attachDiscordRoutes\(server/);
  assert.match(content, /attachMapSceneDiscordRoutes\(server/);
  assert.match(content, /attachDiscordSecurity\(server/);
  assert.match(content, /attachProductionControlRoutes\(server/);
  assert.match(content, /attachLaunchContext\(server/);
  assert.match(content, /configureHttpServer\(server, config\)/);
  assert.match(content, /server\.listen\(config\.port, config\.host/);
  assert.match(content, /process\.once\("SIGTERM"/);
  assert.match(content, /encounterEngine/);
});

test("build validates every production and app-integration runtime module", async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
  assert.equal(packageJson.version, "0.12.1");
  for (const modulePath of [
    "integrations/khaos-nexus/ai-service-client.js",
    "src/runtime-config.js",
    "src/http-security.js",
    "src/launch-context.js",
    "src/launch-control-store.js",
    "src/provider-safety.js",
    "src/safe-supabase.js",
    "src/co-dm.js",
    "src/co-dm-http.js",
    "src/discord-http.js",
    "src/discord-security.js",
    "src/session-intelligence.js",
    "src/session-intelligence-provider.js",
    "src/session-intelligence-store.js",
    "src/session-intelligence-http.js",
    "src/session-intelligence-public.js",
    "src/revision-contract.js",
    "src/retrieval.js",
    "src/retrieval-store.js",
    "src/retrieval-http.js",
    "src/map-scenes.js",
    "src/map-scene-store.js",
    "src/map-scene-http.js",
    "src/map-scene-discord.js",
    "src/evaluations.js",
    "src/production-context.js",
    "src/production-control-store.js",
    "src/production-controls.js",
    "src/production-control-http.js",
  ]) {
    assert.match(packageJson.scripts.build, new RegExp(modulePath.replaceAll(".", "\\.")));
  }
  assert.equal(packageJson.scripts["test:launch"].includes("provider-launch-contract.test.js"), true);
  assert.equal(packageJson.scripts["test:integration"], "node --test tests/khaos-nexus-client.test.js");
  assert.equal(packageJson.scripts["smoke:production"], "node scripts/production-smoke.js");
});

test("integration manifest pins the privileged desktop and provider boundary", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.equal(manifest.minimumServiceVersion, "0.12.1");
  assert.equal(manifest.apiVersion, "1");
  assert.equal(manifest.providerContract.productionModel, "gpt-5-mini-2025-08-07");
  assert.equal(manifest.providerContract.responseStoreRequested, false);
  assert.equal(manifest.providerContract.dataRetentionControlledByProviderProject, true);
  assert.equal(manifest.transport.mainProcessOnly, true);
  assert.equal(manifest.transport.productionHttpsRequired, true);
  assert.equal(manifest.transport.authentication, "supabase-bearer");
  assert.ok(manifest.requiredCapabilities.includes("dnd.co-dm.draft"));
  assert.ok(manifest.excludedCapabilities.includes("voice-co-dm"));
  assert.ok(manifest.excludedCapabilities.includes("renderer-held-openai-key"));
});
