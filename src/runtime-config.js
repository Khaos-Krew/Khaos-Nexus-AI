import { isIP } from "node:net";

const PROVIDERS = ["mock", "openai"];
const STORES = ["json", "supabase"];
const LAUNCH_OPENAI_MODEL = "gpt-5-mini-2025-08-07";
const OFFICIAL_OPENAI_HOST = "api.openai.com";

function configurationError(message) {
  const error = new Error(`Invalid runtime configuration: ${message}`);
  error.code = "INVALID_RUNTIME_CONFIGURATION";
  return error;
}

function has(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined;
}

function text(env, name, { defaultValue = "", required = false } = {}) {
  const value = has(env, name) ? String(env[name]).trim() : defaultValue;
  if (required && !value) throw configurationError(`${name} is required`);
  return value;
}

function boolean(env, name, defaultValue = false) {
  if (!has(env, name) || String(env[name]).trim() === "") return defaultValue;
  const value = String(env[name]).trim();
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw configurationError(`${name} must be true or false`);
}

function integer(env, name, defaultValue, { min, max }) {
  if (!has(env, name) || String(env[name]).trim() === "") return defaultValue;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw configurationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function enumValue(env, name, allowed, defaultValue, required) {
  const value = text(env, name, { defaultValue, required }).toLowerCase();
  if (!allowed.includes(value)) {
    throw configurationError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function normalizedHost(value) {
  const host = value.trim().replace(/^\[(.*)\]$/, "$1");
  if (!host || (/[\s/:?#@]/.test(host) && !isIP(host))) {
    throw configurationError("HOST must be an IP address or hostname without a scheme, port, path, query, or fragment");
  }
  if (!isIP(host) && !/^[a-z0-9.-]+$/i.test(host)) {
    throw configurationError("HOST contains invalid characters");
  }
  return host;
}

export function isLoopbackHost(value) {
  const host = String(value ?? "").trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function normalizedUrl(value, {
  name,
  production,
  allowPath = true,
  originOnly = false,
  allowWildcard = false,
}) {
  if (allowWildcard && value === "*") return "*";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configurationError(`${name} must be a valid absolute URL`);
  }
  if (url.username || url.password) throw configurationError(`${name} must not contain embedded credentials`);
  if (url.search || url.hash) throw configurationError(`${name} must not contain a query or fragment`);
  const local = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && !production)) {
    throw configurationError(`${name} must use HTTPS outside local development`);
  }
  if (originOnly && url.pathname !== "/") throw configurationError(`${name} must be an origin without a path`);
  if (!allowPath && url.pathname !== "/") throw configurationError(`${name} must not contain a path`);
  return originOnly ? url.origin : url.toString().replace(/\/$/, "");
}

export function loadRuntimeConfig(env = process.env) {
  const nodeEnv = text(env, "NODE_ENV", { defaultValue: "development" }).toLowerCase();
  const production = nodeEnv === "production";

  if (production) {
    for (const requiredName of ["HOST", "AI_PROVIDER", "CAMPAIGN_STORE", "AUTH_REQUIRED", "CORS_ORIGIN"]) {
      if (!has(env, requiredName) || !String(env[requiredName]).trim()) {
        throw configurationError(`${requiredName} must be explicitly set in production`);
      }
    }
  }

  const provider = enumValue(env, "AI_PROVIDER", PROVIDERS, "mock", production);
  const store = enumValue(env, "CAMPAIGN_STORE", STORES, "json", production);
  const authRequired = boolean(env, "AUTH_REQUIRED", false);
  const host = normalizedHost(text(env, "HOST", { defaultValue: "127.0.0.1", required: production }));
  const port = integer(env, "PORT", 8787, { min: 1, max: 65535 });
  const corsOrigin = normalizedUrl(text(env, "CORS_ORIGIN", {
    defaultValue: "http://localhost:3000",
    required: production,
  }), {
    name: "CORS_ORIGIN",
    production,
    originOnly: true,
    allowWildcard: !production,
  });

  if (production && provider !== "openai") throw configurationError("AI_PROVIDER must be openai in production");
  if (production && store !== "supabase") throw configurationError("CAMPAIGN_STORE must be supabase in production");
  if (production && !authRequired) throw configurationError("AUTH_REQUIRED must be true in production");
  if (production && corsOrigin === "*") throw configurationError("CORS_ORIGIN cannot be * in production");
  if (!isLoopbackHost(host) && (!authRequired || store !== "supabase")) {
    throw configurationError("non-loopback HOST requires authenticated Supabase mode");
  }

  const openAiApiKey = text(env, "OPENAI_API_KEY", { required: provider === "openai" });
  const openAiModel = text(env, "OPENAI_MODEL", { defaultValue: LAUNCH_OPENAI_MODEL, required: provider === "openai" });
  const openAiBaseUrl = normalizedUrl(text(env, "OPENAI_BASE_URL", {
    defaultValue: "https://api.openai.com/v1",
    required: provider === "openai",
  }), {
    name: "OPENAI_BASE_URL",
    production,
    allowPath: true,
  });
  if (production && provider === "openai") {
    if (openAiModel !== LAUNCH_OPENAI_MODEL) {
      throw configurationError(`OPENAI_MODEL must be ${LAUNCH_OPENAI_MODEL} for launch`);
    }
    if (new URL(openAiBaseUrl).hostname.toLowerCase() !== OFFICIAL_OPENAI_HOST) {
      throw configurationError(`OPENAI_BASE_URL must use ${OFFICIAL_OPENAI_HOST} in production`);
    }
  }

  const supabaseUrl = text(env, "SUPABASE_URL", { required: store === "supabase" || authRequired });
  const supabasePublishableKey = text(env, "SUPABASE_PUBLISHABLE_KEY", {
    required: store === "supabase" || authRequired,
  });
  if (supabaseUrl) normalizedUrl(supabaseUrl, { name: "SUPABASE_URL", production, allowPath: false });
  if (/service_role|sb_secret_/i.test(supabasePublishableKey)) {
    throw configurationError("SUPABASE_PUBLISHABLE_KEY must not be a service-role or secret key");
  }

  const requestTimeoutMs = integer(env, "REQUEST_TIMEOUT_MS", 70_000, { min: 5_000, max: 300_000 });
  const headersTimeoutMs = integer(env, "HEADERS_TIMEOUT_MS", 10_000, { min: 1_000, max: 60_000 });
  if (headersTimeoutMs >= requestTimeoutMs) {
    throw configurationError("HEADERS_TIMEOUT_MS must be lower than REQUEST_TIMEOUT_MS");
  }

  return Object.freeze({
    nodeEnv,
    production,
    provider,
    store,
    authRequired,
    host,
    port,
    corsOrigin,
    openAiApiKey,
    openAiModel,
    openAiBaseUrl,
    supabaseUrl,
    supabasePublishableKey,
    dataDir: text(env, "DATA_DIR", { defaultValue: "./data" }),
    trustProxy: boolean(env, "TRUST_PROXY", false),
    rateLimitMaxEntries: integer(env, "RATE_LIMIT_MAX_ENTRIES", 10_000, { min: 100, max: 1_000_000 }),
    requestTimeoutMs,
    headersTimeoutMs,
    keepAliveTimeoutMs: integer(env, "KEEP_ALIVE_TIMEOUT_MS", 5_000, { min: 1_000, max: 60_000 }),
    shutdownGraceMs: integer(env, "SHUTDOWN_GRACE_MS", 10_000, { min: 1_000, max: 120_000 }),
    maxRequestsPerSocket: integer(env, "MAX_REQUESTS_PER_SOCKET", 1_000, { min: 1, max: 100_000 }),
  });
}
