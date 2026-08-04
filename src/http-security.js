import { isIP } from "node:net";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizedIp(value) {
  if (typeof value !== "string") return null;
  let candidate = value.trim().replace(/^"|"$/g, "");
  if (candidate.startsWith("[")) candidate = candidate.slice(1, candidate.indexOf("]"));
  if (candidate.startsWith("::ffff:")) candidate = candidate.slice(7);
  return isIP(candidate) ? candidate : null;
}

export function requestClientKey(request, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const values = Array.isArray(forwarded) ? forwarded : typeof forwarded === "string" ? [forwarded] : [];
    const chain = values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const address = normalizedIp(chain[index]);
      if (address) return address;
    }
    const realIp = normalizedIp(Array.isArray(request.headers["x-real-ip"])
      ? request.headers["x-real-ip"][0]
      : request.headers["x-real-ip"]);
    if (realIp) return realIp;
  }
  return normalizedIp(request.socket?.remoteAddress) ?? "unknown";
}

export function createBoundedRateLimiter({
  windowMs = 60_000,
  limit = 60,
  maxEntries = 10_000,
  now = () => Date.now(),
} = {}) {
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error("windowMs must be a positive integer");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
  const buckets = new Map();
  let nextSweep = 0;

  function sweep(currentTime, forceCapacity = false) {
    if (!forceCapacity && currentTime < nextSweep) return;
    for (const [key, bucket] of buckets) {
      if (currentTime - bucket.startedAt >= windowMs) buckets.delete(key);
    }
    while (buckets.size >= maxEntries) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
    nextSweep = currentTime + windowMs;
  }

  const allow = (keyValue) => {
    const key = String(keyValue ?? "unknown").slice(0, 256);
    const currentTime = now();
    sweep(currentTime, !buckets.has(key) && buckets.size >= maxEntries);
    let bucket = buckets.get(key);
    if (!bucket || currentTime - bucket.startedAt >= windowMs) {
      if (!bucket && buckets.size >= maxEntries) sweep(currentTime, true);
      bucket = { startedAt: currentTime, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit;
  };
  allow.size = () => buckets.size;
  allow.clear = () => buckets.clear();
  return allow;
}

export function tenantIdFromHeader(request, { required = false } = {}) {
  const value = request.headers["x-khaos-tenant-id"];
  const tenantId = Array.isArray(value) ? value[0] : value;
  if (tenantId === undefined || tenantId === null || tenantId === "") {
    if (!required) return null;
    const error = new Error("X-Khaos-Tenant-Id is required for stateless authenticated generation");
    error.status = 400;
    error.field = "X-Khaos-Tenant-Id";
    throw error;
  }
  if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
    const error = new Error("X-Khaos-Tenant-Id must be a UUID");
    error.status = 400;
    error.field = "X-Khaos-Tenant-Id";
    throw error;
  }
  return tenantId.toLowerCase();
}

export function publicError(error, { defaultMessage = "Internal server error" } = {}) {
  const status = Number.isInteger(error?.status)
    ? error.status
    : error?.name === "ValidationError" || error?.name === "TypeError" ? 400 : 500;
  if (status === 400) return { status, message: error?.message || "Invalid request", field: error?.field };
  if (status === 401) return { status, message: "Authentication is required" };
  if (status === 403) return { status, message: "Permission denied" };
  if (status === 404) return { status, message: error?.message || "Resource not found" };
  if (status === 405) return { status, message: "Method not allowed" };
  if (status === 409) return { status, message: "The resource changed; refresh and retry" };
  if (status === 413) return { status, message: "Request body is too large" };
  if (status === 429) return { status, message: "Rate limit or AI budget exceeded" };
  if (status === 502 || status === 503 || status === 504) {
    return { status, message: "An upstream service is temporarily unavailable" };
  }
  return { status: 500, message: defaultMessage };
}

export function logInternalError(error, context = {}) {
  const production = process.env.NODE_ENV === "production";
  const record = {
    level: "error",
    event: context.event ?? "request.failed",
    requestId: context.requestId ?? null,
    path: context.path ?? null,
    name: typeof error?.name === "string" ? error.name : "Error",
    code: typeof error?.code === "string" ? error.code : null,
    status: Number.isInteger(error?.status) ? error.status : null,
    providerStatus: Number.isInteger(error?.providerStatus) ? error.providerStatus : null,
    ...(production ? {} : { message: typeof error?.message === "string" ? error.message.slice(0, 500) : "" }),
  };
  console.error(JSON.stringify(record));
}

export function configureHttpServer(server, config) {
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = config.maxRequestsPerSocket;
  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  return server;
}
