import assert from "node:assert/strict";
import test from "node:test";
import {
  discordCommandDefinitions,
  validateDiscordBindingRequest,
  validateDiscordCommandRequest,
} from "../src/discord-bridge.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const HOME_ID = "22222222-2222-4222-8222-222222222222";

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
  const command = validateDiscordCommandRequest({
    registeredAppId: APP_ID,
    guildId: "123456789012345678",
    resourceId: "223456789012345678",
    discordUserId: "423456789012345678",
    command: "roll",
    options: { notation: "2d20kh1+5" },
  });
  assert.equal(command.options.notation, "2d20kh1+5");

  assert.throws(
    () => validateDiscordCommandRequest({
      registeredAppId: APP_ID,
      guildId: "not-a-snowflake",
      resourceId: "223456789012345678",
      discordUserId: "423456789012345678",
      command: "campaign_status",
      options: {},
    }),
    /Discord snowflake/i,
  );
});

test("Discord manager actions validate their identifiers", () => {
  const command = validateDiscordCommandRequest({
    registeredAppId: APP_ID,
    guildId: "123456789012345678",
    resourceId: "223456789012345678",
    discordUserId: "423456789012345678",
    command: "approve_homebrew",
    options: { homebrewId: HOME_ID },
  });
  assert.equal(command.options.homebrewId, HOME_ID);
});
