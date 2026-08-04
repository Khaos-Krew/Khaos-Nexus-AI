import assert from "node:assert/strict";
import test from "node:test";
import {
  KhaosNexusAiClient,
  KhaosNexusAiServiceError,
} from "../integrations/khaos-nexus/ai-service-client.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("health verifies API version, service version, and required capability", async () => {
  const client = new KhaosNexusAiClient({
    baseUrl: "https://ai.example.com",
    getAccessToken: () => "token",
    getTenantId: () => tenantId,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://ai.example.com/health");
      assert.equal(options.headers.Authorization, undefined);
      return jsonResponse({
        status: "ok",
        apiVersion: "1",
        version: "0.12.0",
        capabilities: ["dnd.co-dm.draft"],
      });
    },
  });
  assert.equal((await client.health()).status, "ok");
});

test("Co-DM calls carry bearer, tenant, and matching request identifiers", async () => {
  const client = new KhaosNexusAiClient({
    baseUrl: "https://ai.example.com",
    getAccessToken: async () => "supabase-access-token",
    getTenantId: async () => tenantId,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://ai.example.com/api/v1/dnd/co-dm/drafts");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer supabase-access-token");
      assert.equal(options.headers["X-Khaos-Tenant-Id"], tenantId);
      assert.equal(options.headers["X-Khaos-Request-Id"], requestId);
      const body = JSON.parse(options.body);
      assert.equal(body.requestId, requestId);
      assert.equal(body.apiVersion, "1");
      assert.equal(body.model, "default");
      return jsonResponse({ apiVersion: "1", requestId, draft: { content: "Draft" } }, {
        headers: { "X-Khaos-Request-Id": requestId },
      });
    },
  });

  const result = await client.createCoDmDraft({
    requestId,
    workflow: "session_prep",
    prompt: "Prepare the session",
    context: {},
    limits: {},
    policy: {},
  });
  assert.equal(result.draft.content, "Draft");
});

test("stateless calls fail before transport when tenant context is unavailable", async () => {
  let called = false;
  const client = new KhaosNexusAiClient({
    baseUrl: "https://ai.example.com",
    getAccessToken: () => "token",
    getTenantId: () => null,
    fetchImpl: async () => { called = true; return jsonResponse({}); },
  });
  await assert.rejects(() => client.generateMap({ prompt: "map" }), /active tenant ID is unavailable/);
  assert.equal(called, false);
});

test("safe service errors preserve correlation without exposing credentials", async () => {
  const client = new KhaosNexusAiClient({
    baseUrl: "https://ai.example.com",
    getAccessToken: () => "secret-token",
    getTenantId: () => tenantId,
    fetchImpl: async () => jsonResponse({
      apiVersion: "1",
      requestId,
      error: { code: "RATE_LIMITED", message: "Request is limited", retryable: true },
    }, { status: 429, headers: { "X-Khaos-Request-Id": requestId } }),
  });
  await assert.rejects(
    () => client.generateHomebrew({ concept: "test" }),
    (error) => {
      assert.ok(error instanceof KhaosNexusAiServiceError);
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.retryable, true);
      assert.equal(error.requestId, requestId);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});

test("incompatible service versions are rejected", async () => {
  const client = new KhaosNexusAiClient({
    baseUrl: "https://ai.example.com",
    getAccessToken: () => "token",
    getTenantId: () => tenantId,
    fetchImpl: async () => jsonResponse({
      status: "ok",
      apiVersion: "1",
      version: "0.11.9",
      capabilities: ["dnd.co-dm.draft"],
    }),
  });
  await assert.rejects(() => client.health(), (error) => error.code === "AI_SERVICE_INCOMPATIBLE");
});
