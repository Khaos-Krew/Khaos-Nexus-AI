import assert from "node:assert/strict";
import test from "node:test";
import {
  createBoundedRateLimiter,
  publicError,
  requestClientKey,
  tenantIdFromHeader,
} from "../src/http-security.js";

function request(headers = {}, remoteAddress = "127.0.0.1") {
  return { headers, socket: { remoteAddress } };
}

test("bounded rate limiter enforces limits and caps storage", () => {
  let current = 0;
  const allow = createBoundedRateLimiter({ windowMs: 1000, limit: 2, maxEntries: 3, now: () => current });
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), false);
  allow("b");
  allow("c");
  allow("d");
  assert.ok(allow.size() <= 3);
  current = 2000;
  assert.equal(allow("a"), true);
  assert.ok(allow.size() <= 3);
});

test("trusted proxy identity uses the rightmost valid forwarded address", () => {
  const value = requestClientKey(request({ "x-forwarded-for": "198.51.100.8, 10.0.0.2" }, "10.0.0.3"), { trustProxy: true });
  assert.equal(value, "10.0.0.2");
  assert.equal(requestClientKey(request({ "x-forwarded-for": "198.51.100.8" }, "10.0.0.3"), { trustProxy: false }), "10.0.0.3");
});

test("tenant header is explicit and UUID validated", () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  assert.equal(tenantIdFromHeader(request({ "x-khaos-tenant-id": tenantId }), { required: true }), tenantId);
  assert.throws(() => tenantIdFromHeader(request(), { required: true }), /required/);
  assert.throws(() => tenantIdFromHeader(request({ "x-khaos-tenant-id": "wrong" }), { required: true }), /UUID/);
});

test("public errors hide upstream and database details", () => {
  assert.deepEqual(publicError(Object.assign(new Error("database secret"), { status: 503 })), {
    status: 503,
    message: "An upstream service is temporarily unavailable",
  });
  assert.deepEqual(publicError(Object.assign(new Error("bad field"), { status: 400, field: "name" })), {
    status: 400,
    message: "bad field",
    field: "name",
  });
});
