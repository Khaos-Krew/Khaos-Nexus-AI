import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexUrl = new URL("../src/index.js", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);

test("runtime attaches the desktop Co-DM contract and shared production boundary", async () => {
  const content = await readFile(indexUrl, "utf8");
  assert.match(content, /withCoDmDraft\(withSessionIntelligence\(new MockAiProvider\(\)\)\)/);
  assert.match(content, /withSessionIntelligenceStore\(/);
  assert.match(content, /withRetrievalStore\(/);
  assert.match(content, /withMapSceneStore\(/);
  assert.match(content, /withProductionControlStore\(/);
  assert.match(content, /withProductionControls\(baseProvider, persistence\.store\)/);
  assert.match(content, /attachCoDmRoutes\(server/);
  assert.match(content, /attachSessionIntelligenceRoutes\(server/);
  assert.match(content, /attachRetrievalRoutes\(server/);
  assert.match(content, /attachMapSceneRoutes\(server/);
  assert.match(content, /attachDiscordRoutes\(server/);
  assert.match(content, /attachMapSceneDiscordRoutes\(server/);
  assert.match(content, /attachDiscordSecurity\(server/);
  assert.match(content, /attachProductionControlRoutes\(server/);
  assert.match(content, /encounterEngine/);
});

test("build validates every runtime wrapper introduced through Phase 8", async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
  assert.equal(packageJson.version, "0.11.0");
  for (const modulePath of [
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
});
