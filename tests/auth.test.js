import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { MemoryCampaignStore } from "../src/store.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "header.payload.signature-value-long-enough";

const provider = {
  name: "fake",
  model: "test",
  async generateTurn() {
    throw new Error("not used");
  },
  async generateHomebrew() {
    throw new Error("not used");
  },
  async generateMap() {
    throw new Error("not used");
  },
};

async function withServer(options, run) {
  const server = createApp({
    store: new MemoryCampaignStore(),
    provider,
    corsOrigin: "*",
    rateLimit: { limit: 1_000 },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json() };
}

test("health remains available when API authentication is required", async () => {
  await withServer({ authRequired: true }, async (baseUrl) => {
    const response = await requestJson(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.equal(response.body.authentication, "required");
  });
});

test("protected API routes reject missing Bearer tokens", async () => {
  await withServer({ authRequired: true }, async (baseUrl) => {
    const response = await requestJson(`${baseUrl}/api/v1/campaigns`);
    assert.equal(response.status, 401);
    assert.match(response.body.error, /Bearer/i);
  });
});

test("verified Bearer tokens expose trusted user context", async () => {
  const seen = [];
  const authVerifier = {
    async verify(token) {
      seen.push(token);
      return { id: USER_ID, email: "dm@example.com", appMetadata: {} };
    },
  };

  await withServer({ authRequired: true, authVerifier }, async (baseUrl) => {
    const response = await requestJson(`${baseUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.user.id, USER_ID);
    assert.deepEqual(seen, [TOKEN]);
  });
});

test("Supabase-mode campaign creation requires a tenant UUID", async () => {
  const store = new MemoryCampaignStore();
  store.requiresAuth = true;
  const authVerifier = { async verify() { return { id: USER_ID }; } };

  await withServer({ store, authRequired: true, authVerifier }, async (baseUrl) => {
    const response = await requestJson(`${baseUrl}/api/v1/campaigns`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Missing Tenant" }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.field, "tenantId");
  });
});
