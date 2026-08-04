import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeUrl = new URL("../src/runtime-config.js", import.meta.url);
const aiUrl = new URL("../src/production-controls.js", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20260804022000_dnd_ai_pin_openai_snapshot.sql", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);
const coDmDocUrl = new URL("../docs/desktop-co-dm-v1.md", import.meta.url);
const appDocUrl = new URL("../docs/khaos-nexus-app-integration.md", import.meta.url);
const checklistUrl = new URL("../docs/launch-checklist.md", import.meta.url);

const SNAPSHOT = "gpt-5-mini-2025-08-07";

test("production runtime pins an immutable evaluated OpenAI snapshot", async () => {
  const runtime = await readFile(runtimeUrl, "utf8");
  assert.match(runtime, new RegExp(`LAUNCH_OPENAI_MODEL = "${SNAPSHOT}"`));
  assert.match(runtime, /OPENAI_MODEL must be \$\{LAUNCH_OPENAI_MODEL\} for launch/);
  assert.doesNotMatch(runtime, /LAUNCH_OPENAI_MODEL = "gpt-5-mini";/);
});

test("provider request disables response storage and records actual usage fields", async () => {
  const controls = await readFile(aiUrl, "utf8");
  assert.match(controls, /store: false/);
  assert.match(controls, /max_output_tokens/);
  assert.match(controls, /body\.usage\?\.input_tokens/);
  assert.match(controls, /body\.usage\?\.output_tokens/);
  assert.match(controls, /cached_tokens/);
  assert.match(controls, /reasoning_tokens/);
  assert.doesNotMatch(controls, /background:\s*true/);
});

test("database policy deactivates moving aliases and activates launch-2 snapshot pricing", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, new RegExp(`model_pattern <> '${SNAPSHOT}'`));
  assert.match(sql, new RegExp(`'${SNAPSHOT}'`));
  assert.match(sql, /'launch-2'/);
  assert.match(sql, /250000/);
  assert.match(sql, /2000000/);
  assert.match(sql, /set active = false/);
  assert.match(sql, /set active = true/);
});

test("operator and app documentation does not overclaim Zero Data Retention", async () => {
  const docs = await Promise.all([
    readFile(readmeUrl, "utf8"),
    readFile(coDmDocUrl, "utf8"),
    readFile(appDocUrl, "utf8"),
    readFile(checklistUrl, "utf8"),
  ]);
  for (const content of docs) {
    assert.match(content, /store: false/);
    assert.match(content, /Zero Data Retention/);
    assert.match(content, /Modified Abuse Monitoring/);
    assert.match(content, /not|does not/i);
  }
});
