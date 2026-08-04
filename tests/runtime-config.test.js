import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackHost, loadRuntimeConfig } from "../src/runtime-config.js";

const SNAPSHOT = "gpt-5-mini-2025-08-07";

function productionEnv(overrides = {}) {
  return {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "8787",
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "test-key-not-used",
    OPENAI_MODEL: SNAPSHOT,
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    CAMPAIGN_STORE: "supabase",
    AUTH_REQUIRED: "true",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    CORS_ORIGIN: "https://desktop.example.com",
    ...overrides,
  };
}

test("development defaults bind only to loopback", () => {
  const config = loadRuntimeConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.provider, "mock");
  assert.equal(config.store, "json");
  assert.equal(config.authRequired, false);
});

test("production accepts the exact pinned launch provider configuration", () => {
  const config = loadRuntimeConfig(productionEnv());
  assert.equal(config.production, true);
  assert.equal(config.provider, "openai");
  assert.equal(config.store, "supabase");
  assert.equal(config.authRequired, true);
  assert.equal(config.openAiModel, SNAPSHOT);
  assert.equal(config.openAiBaseUrl, "https://api.openai.com/v1");
});

test("production rejects missing or insecure defaults", () => {
  assert.throws(() => loadRuntimeConfig({ NODE_ENV: "production" }), /HOST must be explicitly set/);
  assert.throws(() => loadRuntimeConfig(productionEnv({ AI_PROVIDER: "mock" })), /AI_PROVIDER must be openai/);
  assert.throws(() => loadRuntimeConfig(productionEnv({ CAMPAIGN_STORE: "json" })), /CAMPAIGN_STORE must be supabase/);
  assert.throws(() => loadRuntimeConfig(productionEnv({ AUTH_REQUIRED: "false" })), /AUTH_REQUIRED must be true/);
  assert.throws(() => loadRuntimeConfig(productionEnv({ CORS_ORIGIN: "*" })), /CORS_ORIGIN/);
});

test("non-loopback binding requires authenticated Supabase mode", () => {
  assert.throws(() => loadRuntimeConfig({
    HOST: "0.0.0.0",
    CAMPAIGN_STORE: "json",
    AUTH_REQUIRED: "false",
  }), /non-loopback HOST requires authenticated Supabase mode/);
});

test("production rejects moving aliases, unreviewed models, and provider proxies", () => {
  assert.throws(() => loadRuntimeConfig(productionEnv({ OPENAI_MODEL: "gpt-5-mini" })), new RegExp(`OPENAI_MODEL must be ${SNAPSHOT}`));
  assert.throws(() => loadRuntimeConfig(productionEnv({ OPENAI_MODEL: "gpt-5.4-mini" })), new RegExp(`OPENAI_MODEL must be ${SNAPSHOT}`));
  assert.throws(() => loadRuntimeConfig(productionEnv({ OPENAI_BASE_URL: "https://proxy.example.com/v1" })), /api.openai.com/);
});

test("provider and Supabase URLs reject credential leakage and insecure remote HTTP", () => {
  assert.throws(() => loadRuntimeConfig(productionEnv({ OPENAI_BASE_URL: "http://api.openai.com/v1" })), /must use HTTPS/);
  assert.throws(() => loadRuntimeConfig(productionEnv({ OPENAI_BASE_URL: "https://key@example.com/v1" })), /embedded credentials/);
  assert.throws(() => loadRuntimeConfig(productionEnv({ SUPABASE_URL: "http://example.supabase.co" })), /must use HTTPS/);
  assert.throws(() => loadRuntimeConfig(productionEnv({ SUPABASE_PUBLISHABLE_KEY: "sb_secret_bad" })), /must not be a service-role or secret key/);
});

test("loopback detection handles IPv4, IPv6, and localhost", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});
