const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

function serviceError(message, status = 500, details = undefined) {
  const error = new Error(message);
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("SUPABASE_URL is required");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("SUPABASE_URL must use HTTPS outside local development");
  }
  return url.toString().replace(/\/$/, "");
}

function requirePublishableKey(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");
  if (/service_role|sb_secret_/i.test(value)) {
    throw new Error("Use a Supabase publishable key, never a service-role or secret key");
  }
  return value.trim();
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function describeSupabaseFailure(payload, fallback) {
  if (payload && typeof payload === "object") {
    return payload.message || payload.msg || payload.error_description || payload.error || fallback;
  }
  return typeof payload === "string" && payload ? payload.slice(0, 500) : fallback;
}

export function extractBearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export class SupabaseAuthVerifier {
  constructor({ url, publishableKey, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
    this.url = normalizeBaseUrl(url);
    this.publishableKey = requirePublishableKey(publishableKey);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }
  async verify(accessToken) {
    if (typeof accessToken !== "string" || accessToken.length < 20) {
      throw serviceError("A valid Bearer token is required", 401);
    }
    let response;
    try {
      response = await this.fetchImpl(`${this.url}/auth/v1/user`, {
        method: "GET",
        headers: { apikey: this.publishableKey, Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError") throw serviceError("Authentication verification timed out", 503);
      throw serviceError("Authentication service is unavailable", 503);
    }
    const payload = await parseResponse(response);
    if (!response.ok) throw serviceError(describeSupabaseFailure(payload, "Invalid or expired access token"), 401);
    if (!payload || typeof payload !== "object" || !UUID_PATTERN.test(payload.id ?? "")) {
      throw serviceError("Authentication response did not contain a valid user", 401);
    }
    return {
      id: payload.id,
      email: typeof payload.email === "string" ? payload.email : "",
      appMetadata: payload.app_metadata && typeof payload.app_metadata === "object" ? payload.app_metadata : {},
      aud: payload.aud ?? "authenticated",
    };
  }
}

export class SupabaseRestClient {
  constructor({ url, publishableKey, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
    this.url = normalizeBaseUrl(url);
    this.publishableKey = requirePublishableKey(publishableKey);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }
  async request(path, { token, method = "GET", query, body, prefer, headers = {} } = {}) {
    if (typeof token !== "string" || !token) throw serviceError("Authenticated Supabase access is required", 401);
    const url = new URL(`${this.url}/rest/v1/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const requestHeaders = {
      apikey: this.publishableKey,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...headers,
    };
    if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
    if (prefer) requestHeaders.Prefer = prefer;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError") throw serviceError("Supabase request timed out", 503);
      throw serviceError("Supabase Data API is unavailable", 503);
    }
    const payload = await parseResponse(response);
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? response.status : 502;
      const error = serviceError(describeSupabaseFailure(payload, "Supabase request failed"), status, payload);
      error.supabaseStatus = response.status;
      throw error;
    }
    return payload;
  }
  async rpc(functionName, args, token) {
    if (!IDENTIFIER_PATTERN.test(functionName)) throw new Error("Invalid Supabase RPC function name");
    return this.request(`rpc/${functionName}`, { token, method: "POST", body: args ?? {} });
  }
}

function requireContext(context) {
  if (!context?.token || !context?.user?.id) throw serviceError("Authentication is required", 401);
  return context;
}
function assertUuid(value, field) {
  if (!UUID_PATTERN.test(value ?? "")) throw serviceError(`${field} must be a UUID`, 400);
  return value;
}
function workspaceCampaignToService(workspace) {
  const row = workspace?.campaign;
  if (!row || typeof row !== "object") return null;
  const ai = row.ai_state && typeof row.ai_state === "object" ? row.ai_state : {};
  const characters = Array.isArray(workspace.characters) ? workspace.characters : [];
  return {
    id: row.id, tenantId: row.tenant_id, name: row.name,
    system: row.ruleset || "D&D 5e-compatible",
    mode: ai.mode === "gm" ? "gm" : "co-dm",
    tone: row.description || "Heroic fantasy with meaningful choices",
    contentRating: ai.contentRating || "teen",
    lore: Array.isArray(ai.lore) ? ai.lore : [],
    rulesNotes: Array.isArray(ai.rulesNotes) ? ai.rulesNotes : [],
    playerCharacters: characters.map((character) => ({
      id: character.id, name: character.name,
      playerName: character.player_name || "", summary: character.summary || "",
    })),
    safety: {
      lines: Array.isArray(ai.safety?.lines) ? ai.safety.lines : [],
      veils: Array.isArray(ai.safety?.veils) ? ai.safety.veils : [],
      pauseWords: Array.isArray(ai.safety?.pauseWords) ? ai.safety.pauseWords : ["pause", "red card"],
    },
    currentScene: row.current_location || "",
    worldFacts: Array.isArray(ai.worldFacts) ? ai.worldFacts : [],
    openThreads: Array.isArray(ai.openThreads) ? ai.openThreads : [],
    notes: Array.isArray(ai.notes) ? ai.notes : [],
    transcript: Array.isArray(ai.transcript) ? ai.transcript : [],
    status: row.status || "planning", createdAt: row.created_at, updatedAt: row.updated_at,
    workspaceRole: workspace.role || null,
  };
}
function campaignAiState(campaign) {
  return {
    mode: campaign.mode, contentRating: campaign.contentRating,
    lore: campaign.lore, rulesNotes: campaign.rulesNotes, safety: campaign.safety,
    worldFacts: campaign.worldFacts, openThreads: campaign.openThreads,
    notes: campaign.notes, transcript: campaign.transcript,
  };
}

export class SupabaseCampaignStore {
  constructor(client) {
    if (!client) throw new Error("Supabase REST client is required");
    this.client = client;
    this.requiresAuth = true;
    this.name = "supabase";
  }
  async list(context) {
    requireContext(context);
    const result = await this.client.rpc("dnd_campaign_list", {}, context.token);
    const campaigns = Array.isArray(result) ? result : result?.campaigns;
    return Array.isArray(campaigns) ? campaigns : [];
  }
  async getWorkspace(id, context) {
    requireContext(context); assertUuid(id, "campaign id");
    const workspace = await this.client.rpc("dnd_campaign_workspace", { p_campaign_id: id }, context.token);
    return workspace && typeof workspace === "object" ? workspace : null;
  }
  async get(id, context) { return workspaceCampaignToService(await this.getWorkspace(id, context)); }
  async create(campaign, context) {
    requireContext(context); assertUuid(campaign.tenantId, "tenantId");
    const workspace = await this.client.rpc("dnd_ai_create_campaign", {
      p_tenant_id: campaign.tenantId,
      p_name: campaign.name,
      p_description: campaign.tone,
      p_ruleset: campaign.system,
      p_current_location: campaign.currentScene || "",
      p_ai_state: campaignAiState(campaign),
      p_characters: campaign.playerCharacters.map((character) => ({
        id: character.id, name: character.name,
        playerName: character.playerName, summary: character.summary,
      })),
    }, context.token);
    return workspaceCampaignToService(workspace);
  }
  async update(campaign, context) {
    requireContext(context); assertUuid(campaign.id, "campaign id");
    const workspace = await this.client.rpc("dnd_ai_update_campaign_state", {
      p_campaign_id: campaign.id,
      p_expected_updated_at: campaign.expectedUpdatedAt ?? campaign.updatedAt,
      p_current_location: campaign.currentScene || "",
      p_ai_state: campaignAiState(campaign),
    }, context.token);
    return workspaceCampaignToService(workspace);
  }
  async createHomebrew(campaignId, result, context) {
    requireContext(context); assertUuid(campaignId, "campaign id");
    return this.client.rpc("dnd_ai_create_homebrew", {
      p_campaign_id: campaignId, p_content_type: result.contentType,
      p_name: result.title, p_body: result,
    }, context.token);
  }
  async approveHomebrew(campaignId, homebrewId, context) {
    requireContext(context); assertUuid(campaignId, "campaign id"); assertUuid(homebrewId, "homebrew id");
    return this.client.rpc("dnd_ai_approve_homebrew", {
      p_campaign_id: campaignId, p_homebrew_id: homebrewId,
    }, context.token);
  }
  async executeWorkspaceTool(campaignId, tool, argumentsValue, context) {
    requireContext(context); assertUuid(campaignId, "campaign id");
    return this.client.rpc("dnd_ai_execute_workspace_tool", {
      p_campaign_id: campaignId, p_tool: tool, p_arguments: argumentsValue,
    }, context.token);
  }
  async getEncounterState(campaignId, encounterId, context) {
    requireContext(context); assertUuid(campaignId, "campaign id"); assertUuid(encounterId, "encounter id");
    return this.client.rpc("dnd_ai_encounter_state", {
      p_campaign_id: campaignId, p_encounter_id: encounterId,
    }, context.token);
  }
  async executeEncounterTool(campaignId, tool, argumentsValue, context) {
    requireContext(context); assertUuid(campaignId, "campaign id");
    return this.client.rpc("dnd_ai_execute_encounter_tool", {
      p_campaign_id: campaignId, p_tool: tool, p_arguments: argumentsValue,
    }, context.token);
  }
}
