import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkspaceToolRequest, workspaceToolDefinitions } from "../src/workspace-tools.js";

const toolNames = workspaceToolDefinitions.map((tool) => tool.name);

test("workspace tool discovery exposes the fixed allow-list", () => {
  assert.deepEqual(toolNames, [
    "upsert_npc",
    "upsert_location",
    "upsert_faction",
    "upsert_quest",
    "upsert_loot",
    "upsert_session",
    "approve_session_recap",
    "upsert_calendar_event",
  ]);
});

test("workspace tool validation normalizes an NPC mutation", () => {
  const result = validateWorkspaceToolRequest({
    tool: "upsert_npc",
    arguments: {
      name: "  Ember Warden  ",
      publicSummary: "A guarded smith.",
      gmNotes: "Secretly serves the Crucible.",
      revealed: true,
      metadata: { public: { disposition: "wary" } },
    },
  });
  assert.equal(result.tool, "upsert_npc");
  assert.equal(result.arguments.name, "Ember Warden");
  assert.equal(result.arguments.revealed, true);
  assert.equal(result.arguments.entity, "npc");
});

test("workspace tool validation rejects unsupported tools and fields", () => {
  assert.throws(
    () => validateWorkspaceToolRequest({ tool: "run_sql", arguments: { sql: "drop table x" } }),
    /Unsupported workspace tool/i,
  );
  assert.throws(
    () => validateWorkspaceToolRequest({ tool: "upsert_quest", arguments: { title: "Test", approved: true } }),
    /not allowed/i,
  );
});

test("session recap approval requires a session UUID", () => {
  assert.throws(
    () => validateWorkspaceToolRequest({ tool: "approve_session_recap", arguments: { sessionId: "bad" } }),
    /UUID/i,
  );
});

test("calendar events require valid timestamps and visibility", () => {
  const result = validateWorkspaceToolRequest({
    tool: "upsert_calendar_event",
    arguments: {
      title: "Session Zero",
      startsAt: "2026-08-10T19:00:00-05:00",
      visibility: "campaign",
    },
  });
  assert.equal(result.arguments.startsAt, "2026-08-11T00:00:00.000Z");
  assert.throws(
    () => validateWorkspaceToolRequest({
      tool: "upsert_calendar_event",
      arguments: { title: "Bad", startsAt: "not-a-date" },
    }),
    /ISO timestamp/i,
  );
});
