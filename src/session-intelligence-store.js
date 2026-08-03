import { projectPublicSessionIntelligence } from "./session-intelligence-public.js";

function authRequired(context) {
  if (!context?.token || !context?.user?.id) {
    const error = new Error("Authentication is required");
    error.status = 401;
    throw error;
  }
}

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  throw error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  throw error;
}

function localKey(campaignId, sessionId) {
  return `${campaignId}:${sessionId}`;
}

export function withSessionIntelligenceStore(store) {
  if (!store || typeof store !== "object") throw new Error("Campaign store is required");
  if (typeof store.getSessionIntelligence === "function") return store;

  if (store.requiresAuth) {
    if (!store.client || typeof store.client.rpc !== "function") {
      throw new Error("Authenticated store does not expose a Supabase RPC client");
    }
    store.getSessionIntelligence = async (campaignId, sessionId, context) => {
      authRequired(context);
      return store.client.rpc("dnd_ai_session_intelligence", {
        p_campaign_id: campaignId,
        p_session_id: sessionId,
      }, context.token);
    };
    store.saveSessionIntelligence = async (
      campaignId,
      sessionId,
      intelligence,
      expectedRevision,
      context,
    ) => {
      authRequired(context);
      return store.client.rpc("dnd_ai_save_session_intelligence", {
        p_campaign_id: campaignId,
        p_session_id: sessionId,
        p_intelligence: intelligence,
        p_expected_revision: expectedRevision,
      }, context.token);
    };
    store.approveSessionIntelligence = async (campaignId, sessionId, expectedRevision, context) => {
      authRequired(context);
      return store.client.rpc("dnd_ai_approve_session_intelligence", {
        p_campaign_id: campaignId,
        p_session_id: sessionId,
        p_expected_revision: expectedRevision,
      }, context.token);
    };
    return store;
  }

  const records = new Map();
  store.getSessionIntelligence = async (campaignId, sessionId, context = null) => {
    const workspace = await store.getWorkspace(campaignId, context);
    const session = workspace?.sessions?.find((item) => item.id === sessionId);
    if (!session) return null;
    const record = records.get(localKey(campaignId, sessionId));
    const canManage = context?.localRole !== "player" && context?.localRole !== "viewer";
    return {
      role: canManage ? "dm" : context.localRole,
      canManage,
      session: structuredClone(session),
      intelligence: !record
        ? null
        : canManage
          ? structuredClone(record.intelligence)
          : record.approved
            ? projectPublicSessionIntelligence(record.intelligence)
            : null,
      revision: record?.revision ?? 0,
      approved: Boolean(record?.approved),
      approved_at: record?.approvedAt ?? null,
      updated_at: record?.updatedAt ?? null,
    };
  };
  store.saveSessionIntelligence = async (
    campaignId,
    sessionId,
    intelligence,
    expectedRevision,
    context = null,
  ) => {
    const current = await store.getSessionIntelligence(campaignId, sessionId, context);
    if (!current) notFound("Session not found");
    if (!current.canManage) {
      const error = new Error("Campaign management permission is required");
      error.status = 403;
      throw error;
    }
    if (current.revision !== expectedRevision) conflict("Session intelligence changed; reload before saving");
    const now = new Date().toISOString();
    records.set(localKey(campaignId, sessionId), {
      intelligence: structuredClone(intelligence),
      revision: expectedRevision + 1,
      approved: false,
      approvedAt: null,
      updatedAt: now,
    });
    return store.getSessionIntelligence(campaignId, sessionId, context);
  };
  store.approveSessionIntelligence = async (
    campaignId,
    sessionId,
    expectedRevision,
    context = null,
  ) => {
    const current = await store.getSessionIntelligence(campaignId, sessionId, context);
    if (!current) notFound("Session not found");
    if (!current.canManage) {
      const error = new Error("Campaign management permission is required");
      error.status = 403;
      throw error;
    }
    if (!current.intelligence || current.revision === 0) conflict("No session intelligence draft exists");
    if (current.revision !== expectedRevision) conflict("Session intelligence changed; reload before approving");
    const record = records.get(localKey(campaignId, sessionId));
    record.approved = true;
    record.approvedAt = new Date().toISOString();
    return store.getSessionIntelligence(campaignId, sessionId, context);
  };
  return store;
}
