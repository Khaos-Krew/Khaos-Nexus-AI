import { createHash, randomUUID } from "node:crypto";
import {
  validateRetrievalEntryRequest,
  validateRetrievalSearchRequest,
  validateRetrievalSourceRequest,
} from "./retrieval.js";

function requireAuth(context) {
  if (!context?.token || !context?.user?.id) {
    const error = new Error("Authentication is required");
    error.status = 401;
    throw error;
  }
}

function permissionError(message = "Campaign management permission is required") {
  const error = new Error(message);
  error.status = 403;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function validationError(message, field = "request") {
  const error = new Error(message);
  error.name = "ValidationError";
  error.field = field;
  return error;
}

function canManage(context) {
  return !["player", "viewer"].includes(context?.localRole ?? "dm");
}

function campaignSources(state, campaignId) {
  if (!state.sources.has(campaignId)) state.sources.set(campaignId, []);
  return state.sources.get(campaignId);
}

function sourceEntries(state, sourceId) {
  if (!state.entries.has(sourceId)) state.entries.set(sourceId, []);
  return state.entries.get(sourceId);
}

function hashEntry(input) {
  return createHash("sha256")
    .update(`${input.contentType.toLowerCase()}\n${input.name.toLowerCase()}\n${input.summary}\n${input.fullText}`)
    .digest("hex");
}

function normalizedTerms(query) {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
}

function scoreText(name, summary, content, terms) {
  const values = [
    [name.toLowerCase(), 4],
    [summary.toLowerCase(), 2],
    [content.toLowerCase(), 1],
  ];
  return terms.reduce(
    (score, term) => score + values.reduce((sum, [value, weight]) =>
      sum + (value.split(term).length - 1) * weight, 0),
    0,
  );
}

function excerptFor(text, terms) {
  const normalized = text || "";
  const lower = normalized.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 100) : 0;
  return normalized.slice(start, start + 700);
}

function publicSource(source, roleCanManage) {
  return roleCanManage || source.visibility === "campaign_members";
}

function publicEntry(source, entry, roleCanManage) {
  return roleCanManage ||
    entry.visibility === "campaign_members" ||
    (entry.visibility === "inherit" && source.visibility === "campaign_members");
}

function enforceEntryLicense(source, input) {
  if (input.fullText && !source.fullTextAllowed) {
    throw validationError("Full text is not allowed for this source", "fullText");
  }
  if (["metadata_only", "external_link", "unknown_restricted"].includes(source.licenseType) && input.fullText) {
    throw validationError("Restricted sources may store summaries and metadata only", "fullText");
  }
  if (input.contentOrigin === "partner_api" && source.licenseType !== "partner_api") {
    throw validationError("partner_api content requires a partner_api source", "contentOrigin");
  }
  if (input.contentOrigin === "external_reference" && source.licenseType !== "external_link") {
    throw validationError("external_reference content requires an external_link source", "contentOrigin");
  }
}

async function localSearch(store, state, campaignId, input, context) {
  const roleCanManage = canManage(context);
  const terms = normalizedTerms(input.query);
  const results = [];

  for (const source of campaignSources(state, campaignId)) {
    if (!source.enabled || !publicSource(source, roleCanManage)) continue;
    for (const entry of sourceEntries(state, source.id)) {
      if (!entry.active || !publicEntry(source, entry, roleCanManage)) continue;
      const searchable = source.fullTextAllowed && entry.fullText ? entry.fullText : entry.summary;
      const rank = scoreText(entry.name, entry.summary, searchable, terms);
      if (rank <= 0) continue;
      results.push({
        kind: "source_entry",
        citationId: `source:${source.id}:entry:${entry.id}`,
        sourceId: source.id,
        entryId: entry.id,
        name: entry.name,
        excerpt: excerptFor(searchable, terms),
        sourceName: source.name,
        licenseType: source.licenseType,
        attributionText: source.attributionText,
        externalReferenceUrl: source.externalReferenceUrl,
        contentOrigin: entry.contentOrigin,
        rank,
      });
    }
  }

  const workspace = await store.getWorkspace(campaignId, context);
  for (const homebrew of workspace?.homebrew ?? []) {
    if (!roleCanManage && homebrew.status !== "approved") continue;
    const summary = homebrew.body?.summary ?? homebrew.name ?? "";
    const rank = scoreText(homebrew.name ?? "", summary, JSON.stringify(homebrew.body ?? {}), terms);
    if (rank <= 0) continue;
    results.push({
      kind: "homebrew",
      citationId: `homebrew:${homebrew.id}:revision:${homebrew.revision ?? 1}`,
      sourceId: null,
      entryId: homebrew.id,
      name: homebrew.name,
      excerpt: excerptFor(summary, terms),
      sourceName: "Campaign homebrew",
      licenseType: "user_authored",
      attributionText: "",
      externalReferenceUrl: "",
      contentOrigin: "campaign_generated",
      rank,
    });
  }

  if (typeof store.getSessionIntelligence === "function") {
    const sessions = workspace?.sessions ?? [];
    const records = await Promise.all(sessions.map((session) =>
      store.getSessionIntelligence(campaignId, session.id, context)));
    for (const record of records) {
      if (!record?.intelligence) continue;
      const recap = record.canManage
        ? record.intelligence.gmRecap
        : record.intelligence.playerRecap;
      const title = record.session?.title ?? "Campaign session";
      const rank = scoreText(title, recap ?? "", recap ?? "", terms);
      if (rank <= 0) continue;
      results.push({
        kind: "session_recap",
        citationId: `session:${record.session.id}:intelligence:${record.revision}`,
        sourceId: null,
        entryId: record.session.id,
        name: title,
        excerpt: excerptFor(recap ?? "", terms),
        sourceName: "Campaign session",
        licenseType: "user_authored",
        attributionText: "",
        externalReferenceUrl: "",
        contentOrigin: "campaign_generated",
        rank,
      });
    }
  }

  results.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  return {
    role: roleCanManage ? "dm" : context.localRole,
    canManage: roleCanManage,
    query: input.query,
    results: results.slice(0, input.limit),
    excerptLimit: 700,
    resultLimit: input.limit,
  };
}

export function withRetrievalStore(store) {
  if (!store || typeof store !== "object") throw new Error("Campaign store is required");
  if (typeof store.searchRetrieval === "function") return store;

  if (store.requiresAuth) {
    if (!store.client || typeof store.client.rpc !== "function") {
      throw new Error("Authenticated store does not expose a Supabase RPC client");
    }
    store.getRetrievalSources = async (campaignId, context) => {
      requireAuth(context);
      return store.client.rpc("dnd_ai_retrieval_sources", {
        p_campaign_id: campaignId,
      }, context.token);
    };
    store.upsertRetrievalSource = async (campaignId, value, context) => {
      requireAuth(context);
      const input = validateRetrievalSourceRequest(value);
      return store.client.rpc("dnd_ai_upsert_retrieval_source", {
        p_campaign_id: campaignId,
        p_source_id: input.sourceId,
        p_name: input.name,
        p_ruleset: input.ruleset,
        p_source_version: input.sourceVersion,
        p_license_type: input.licenseType,
        p_license_reference: input.licenseReference,
        p_attribution_text: input.attributionText,
        p_external_reference_url: input.externalReferenceUrl,
        p_full_text_allowed: input.fullTextAllowed,
        p_visibility: input.visibility,
        p_enabled: input.enabled,
      }, context.token);
    };
    store.upsertRetrievalEntry = async (campaignId, sourceId, value, context) => {
      requireAuth(context);
      const input = validateRetrievalEntryRequest(value);
      return store.client.rpc("dnd_ai_upsert_retrieval_entry", {
        p_campaign_id: campaignId,
        p_source_id: sourceId,
        p_entry_id: input.entryId,
        p_content_type: input.contentType,
        p_name: input.name,
        p_summary: input.summary,
        p_full_text: input.fullText,
        p_content_origin: input.contentOrigin,
        p_visibility: input.visibility,
        p_metadata: input.metadata,
      }, context.token);
    };
    store.searchRetrieval = async (campaignId, value, context) => {
      requireAuth(context);
      const input = validateRetrievalSearchRequest(value);
      return store.client.rpc("dnd_ai_search_retrieval", {
        p_campaign_id: campaignId,
        p_query: input.query,
        p_limit: input.limit,
      }, context.token);
    };
    return store;
  }

  const state = { sources: new Map(), entries: new Map() };

  store.getRetrievalSources = async (campaignId, context = null) => {
    const roleCanManage = canManage(context);
    return {
      role: roleCanManage ? "dm" : context.localRole,
      canManage: roleCanManage,
      sources: campaignSources(state, campaignId)
        .filter((source) => source.enabled && publicSource(source, roleCanManage))
        .map((source) => ({
          ...structuredClone(source),
          entryCount: sourceEntries(state, source.id).filter((entry) => entry.active).length,
        })),
    };
  };

  store.upsertRetrievalSource = async (campaignId, value, context = null) => {
    if (!canManage(context)) throw permissionError();
    const input = validateRetrievalSourceRequest(value);
    const sources = campaignSources(state, campaignId);
    let source = input.sourceId ? sources.find((item) => item.id === input.sourceId) : null;
    if (input.sourceId && !source) throw notFound("Retrieval source not found");
    if (!source) {
      source = { id: randomUUID(), campaignId, createdAt: new Date().toISOString() };
      sources.push(source);
    }
    Object.assign(source, {
      name: input.name,
      ruleset: input.ruleset,
      sourceVersion: input.sourceVersion,
      licenseType: input.licenseType,
      licenseReference: input.licenseReference,
      attributionText: input.attributionText,
      externalReferenceUrl: input.externalReferenceUrl,
      fullTextAllowed: input.fullTextAllowed,
      visibility: input.visibility,
      enabled: input.enabled,
      updatedAt: new Date().toISOString(),
    });
    return structuredClone(source);
  };

  store.upsertRetrievalEntry = async (campaignId, sourceId, value, context = null) => {
    if (!canManage(context)) throw permissionError();
    const input = validateRetrievalEntryRequest(value);
    const source = campaignSources(state, campaignId).find((item) => item.id === sourceId && item.enabled);
    if (!source) throw notFound("Enabled retrieval source not found for campaign");
    enforceEntryLicense(source, input);
    const entries = sourceEntries(state, sourceId);
    const contentHash = hashEntry(input);
    let entry = input.entryId
      ? entries.find((item) => item.id === input.entryId)
      : entries.find((item) => item.contentHash === contentHash && item.active);
    if (input.entryId && !entry) throw notFound("Retrieval entry not found");
    if (!entry) {
      entry = { id: randomUUID(), sourceId, createdAt: new Date().toISOString() };
      entries.push(entry);
    }
    Object.assign(entry, {
      contentType: input.contentType,
      name: input.name,
      summary: input.summary,
      fullText: input.fullText,
      contentOrigin: input.contentOrigin,
      visibility: input.visibility,
      metadata: input.metadata,
      contentHash,
      active: true,
      updatedAt: new Date().toISOString(),
    });
    return {
      id: entry.id,
      sourceId,
      contentType: entry.contentType,
      name: entry.name,
      summary: entry.summary,
      contentOrigin: entry.contentOrigin,
      contentHash,
      hasFullText: Boolean(entry.fullText),
      visibility: entry.visibility,
    };
  };

  store.searchRetrieval = async (campaignId, value, context = null) => {
    const input = validateRetrievalSearchRequest(value);
    return localSearch(store, state, campaignId, input, context);
  };

  return store;
}
