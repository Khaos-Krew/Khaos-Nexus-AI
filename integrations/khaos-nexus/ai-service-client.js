import { randomUUID } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configurationError(message) {
  const error = new Error(message);
  error.name = "AiServiceConfigurationError";
  return error;
}

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw configurationError("AI service URL must be an absolute URL"); }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw configurationError("AI service URL must use HTTPS outside local development");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw configurationError("AI service URL must not contain credentials, a query, or a fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function requireUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw configurationError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual, minimum) {
  const actualParts = versionParts(actual);
  const minimumParts = versionParts(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

async function resolvedValue(provider, name) {
  const value = typeof provider === "function" ? await provider() : provider;
  if (typeof value !== "string" || !value.trim()) throw configurationError(`${name} is unavailable`);
  return value.trim();
}

export class KhaosNexusAiServiceError extends Error {
  constructor(message, { status, code, retryable, requestId } = {}) {
    super(message);
    this.name = "KhaosNexusAiServiceError";
    this.status = Number.isInteger(status) ? status : 0;
    this.code = typeof code === "string" ? code : "AI_SERVICE_ERROR";
    this.retryable = retryable === true;
    this.requestId = typeof requestId === "string" ? requestId : null;
  }
}

export class KhaosNexusAiClient {
  constructor({
    baseUrl,
    getAccessToken,
    getTenantId,
    fetchImpl = fetch,
    timeoutMs = 75_000,
    expectedApiVersion = "1",
    minimumServiceVersion = "0.12.1",
  } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (typeof fetchImpl !== "function") throw configurationError("fetchImpl must be a function");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 300_000) {
      throw configurationError("timeoutMs must be an integer from 5000 to 300000");
    }
    if (!versionParts(minimumServiceVersion)) throw configurationError("minimumServiceVersion must be semantic version text");
    this.getAccessToken = getAccessToken;
    this.getTenantId = getTenantId;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.expectedApiVersion = expectedApiVersion;
    this.minimumServiceVersion = minimumServiceVersion;
  }

  async request(path, {
    method = "GET",
    body,
    requestId = randomUUID(),
    tenantRequired = false,
    authRequired = true,
  } = {}) {
    requireUuid(requestId, "requestId");
    const headers = {
      Accept: "application/json",
      "X-Khaos-Request-Id": requestId,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (authRequired) {
      const token = await resolvedValue(this.getAccessToken, "Supabase access token");
      headers.Authorization = `Bearer ${token}`;
    }
    if (tenantRequired) {
      headers["X-Khaos-Tenant-Id"] = requireUuid(
        await resolvedValue(this.getTenantId, "active tenant ID"),
        "active tenant ID",
      );
    }

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new KhaosNexusAiServiceError(
        timedOut ? "The AI service request timed out" : "The AI service is unreachable",
        { status: timedOut ? 504 : 503, code: timedOut ? "AI_SERVICE_TIMEOUT" : "AI_SERVICE_UNREACHABLE", retryable: true, requestId },
      );
    }

    const responseRequestId = response.headers?.get?.("x-khaos-request-id") || requestId;
    let payload = null;
    try { payload = await response.json(); }
    catch {
      throw new KhaosNexusAiServiceError("The AI service returned an invalid response", {
        status: response.status,
        code: "AI_SERVICE_INVALID_RESPONSE",
        retryable: response.status >= 500,
        requestId: responseRequestId,
      });
    }
    if (!response.ok) {
      const envelope = payload?.error;
      const message = typeof envelope === "object" ? envelope.message : typeof envelope === "string" ? envelope : "AI service request failed";
      throw new KhaosNexusAiServiceError(message, {
        status: response.status,
        code: typeof envelope?.code === "string" ? envelope.code : "AI_SERVICE_REQUEST_FAILED",
        retryable: envelope?.retryable === true || response.status === 429 || response.status >= 500,
        requestId: payload?.requestId ?? responseRequestId,
      });
    }
    return payload;
  }

  async health() {
    const payload = await this.request("/health", { authRequired: false });
    if (payload?.status !== "ok" || payload?.apiVersion !== this.expectedApiVersion
      || !versionAtLeast(payload?.version, this.minimumServiceVersion)) {
      throw new KhaosNexusAiServiceError("The AI service is incompatible", {
        status: 503,
        code: "AI_SERVICE_INCOMPATIBLE",
        retryable: false,
      });
    }
    if (!Array.isArray(payload.capabilities) || !payload.capabilities.includes("dnd.co-dm.draft")) {
      throw new KhaosNexusAiServiceError("The AI service does not expose the required Co-DM capability", {
        status: 503,
        code: "AI_CAPABILITY_MISSING",
        retryable: false,
      });
    }
    return payload;
  }

  async createCoDmDraft(input) {
    const requestId = input?.requestId ?? randomUUID();
    const body = { ...input, apiVersion: "1", requestId, model: "default" };
    return this.request("/api/v1/dnd/co-dm/drafts", {
      method: "POST",
      body,
      requestId,
      tenantRequired: true,
    });
  }

  async generateHomebrew(input) {
    return this.request("/api/v1/homebrew/generations", {
      method: "POST",
      body: input,
      tenantRequired: true,
    });
  }

  async generateMap(input) {
    return this.request("/api/v1/maps/generations", {
      method: "POST",
      body: input,
      tenantRequired: true,
    });
  }

  async generateCampaignTurn(campaignId, input) {
    requireUuid(campaignId, "campaignId");
    return this.request(`/api/v1/campaigns/${campaignId}/turns`, {
      method: "POST",
      body: input,
    });
  }

  async generateSessionIntelligence(campaignId, sessionId, input) {
    requireUuid(campaignId, "campaignId");
    requireUuid(sessionId, "sessionId");
    return this.request(`/api/v1/campaigns/${campaignId}/sessions/${sessionId}/intelligence/generate`, {
      method: "POST",
      body: input,
    });
  }
}
