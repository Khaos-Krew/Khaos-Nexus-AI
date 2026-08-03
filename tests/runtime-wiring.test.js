import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexUrl = new URL("../src/index.js", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);

test("runtime attaches Discord, session intelligence, and authorized retrieval routes", async () => {
  const content = await readFile(indexUrl, "utf8");
  assert.match(content, /withSessionIntelligence\(new MockAiProvider\(\)\)/);
  assert.match(content, /withSessionIntelligenceStore\(/);
  assert.match(content, /withRetrievalStore\(/);
  assert.match(content, /attachSessionIntelligenceRoutes\(server/);
  assert.match(content, /attachRetrievalRoutes\(server/);
  assert.match(content, /attachDiscordRoutes\(server/);
  assert.match(content, /attachDiscordSecurity\(server/);
  assert.match(content, /encounterEngine/);
});

test("build validates every runtime wrapper introduced through Phase 6", async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
  for (const modulePath of [
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
  ]) {
    assert.match(packageJson.scripts.build, new RegExp(modulePath.replaceAll(".", "\\.")));
  }
});
