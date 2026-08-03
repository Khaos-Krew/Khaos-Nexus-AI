import assert from "node:assert/strict";
import test from "node:test";
import {
  discordCommandDefinitions,
  validateDiscordBindingRequest,
  validateDiscordCommandRequest,
} from "../src/discord-bridge.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const HOME_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function commandBase(command, options) {
  return {
    registeredAppId: APP_ID,
    guildId: "123456789012345678",
    resourceId: "223456789012345678",
    discordUserId: "423456789012345678",
    command,
    options,
  };
}

test("Discord command discovery exposes only the supported bridge commands", () => {
  assert.deepEqual(
    discordCommandDefinitions.map((command) => command.name),
    [
      "campaign_status",
      "roll",
      "homebrew",
      "approve_homebrew",
      "map",
      "encounter_state",
      "workspace_tool",
      "encounter_tool",
      "session_intelligence",
      "generate_session_intelligence",
      "approve_session_intelligence",
      "search_knowledge",
    ],
  );
});

test("Discord bindings accept only existing text resources and non-voice purposes", () => {
  const binding = validateDiscordBindingRequest({
    registeredAppId: APP_ID,
    guildId: "123456789012345678",
    resourceType: "thread",
    resourceId: "223456789012345678",
    parentChannelId: "323456789012345678",
    purpose: "session_notes",
    isPrimary: false,
  });
  assert.equal(binding.resourceType, "thread");
  assert.equal(binding.active, true);
  assert.throws(
    () => validateDiscordBindingRequest({
      registeredAppId: APP_ID,
      guildId: "123456789012345678",
      resourceId: "223456789012345678",
      purpose: "voice",
    }),
    /purpose must be one of/i,
  );
});

test("Discord commands require valid snowflakes and strict command payloads", () => {
  const command = validateDiscordCommandRequest(commandBase("roll", { notation: "2d20kh1+5" }));
  assert.equal(command.options.notation, "2d20kh1+5");

  assert.throws(
    () => validateDiscordCommandRequest({
      ...commandBase("campaign_status", {}),
      guildId: "not-a-snowflake",
    }),
    /Discord snowflake/i,
  );
});

test("Discord manager actions validate identifiers, revisions, and retrieval queries", () => {
  const homebrew = validateDiscordCommandRequest(commandBase(
    "approve_homebrew",
    { homebrewId: HOME_ID },
  ));
  assert.equal(homebrew.options.homebrewId, HOME_ID);

  const intelligence = validateDiscordCommandRequest(commandBase(
    "session_intelligence",
    { sessionId: SESSION_ID },
  ));
  assert.equal(intelligence.options.sessionId, SESSION_ID);

  const generated = validateDiscordCommandRequest(commandBase(
    "generate_session_intelligence",
    {
      sessionId: SESSION_ID,
      request: { sourceNotes: "PUBLIC FACT: The crucible is damaged." },
      persist: true,
      expectedRevision: 0,
    },
  ));
  assert.equal(generated.options.expectedRevision, 0);

  const approved = validateDiscordCommandRequest(commandBase(
    "approve_session_intelligence",
    { sessionId: SESSION_ID, expectedRevision: 1 },
  ));
  assert.equal(approved.options.expectedRevision, 1);

  const search = validateDiscordCommandRequest(commandBase(
    "search_knowledge",
    { query: "ember crucible", limit: 5 },
  ));
  assert.equal(search.options.limit, 5);
  assert.throws(
    () => validateDiscordCommandRequest(commandBase(
      "search_knowledge",
      { query: "reconstruct the entire chapter" },
    )),
    /cannot reconstruct or export/i,
  );
});
