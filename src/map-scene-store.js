import { randomUUID } from "node:crypto";
import {
  sceneHash,
  validateMapSceneApprovalRequest,
  validateMapSceneSaveRequest,
} from "./map-scenes.js";

function requireAuth(context) {
  if (!context?.token || !context?.user?.id) {
    const error = new Error("Authentication is required");
    error.status = 401;
    throw error;
  }
}

function canManage(context) {
  return !["player", "viewer"].includes(context?.localRole ?? "dm");
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function forbidden(message = "Campaign management permission is required") {
  const error = new Error(message);
  error.status = 403;
  return error;
}

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function validation(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.field = field;
  return error;
}

function sourceMapFor(input, sourceMap) {
  if (!sourceMap || typeof sourceMap !== "object" || Array.isArray(sourceMap)) {
    throw validation("sourceMap must be an object", "sourceMap");
  }
  if (sceneHash(sourceMap) !== input.gmScene.sourceMapHash) {
    throw validation("sourceMap does not match the scene sourceMapHash", "sourceMap");
  }
  return structuredClone(sourceMap);
}

function campaignRecords(state, campaignId) {
  if (!state.has(campaignId)) state.set(campaignId, []);
  return state.get(campaignId);
}

function localSceneRecord(record, context) {
  const manager = canManage(context);
  if (!manager && !record.approvedAt) return null;
  return {
    role: manager ? "dm" : context.localRole,
    canManage: manager,
    scene: {
      id: record.id,
      campaignId: record.campaignId,
      name: record.name,
      sourceMap: manager ? structuredClone(record.sourceMap) : null,
      gmScene: manager ? structuredClone(record.gmScene) : null,
      playerScene: structuredClone(record.playerScene),
      revision: record.revision,
      approved: Boolean(record.approvedAt),
      approvedBy: manager ? record.approvedBy : null,
      approvedAt: record.approvedAt,
      metadata: manager ? structuredClone(record.metadata) : {},
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  };
}

export function withMapSceneStore(store) {
  if (!store || typeof store !== "object") throw new Error("Campaign store is required");
  if (typeof store.getMapScene === "function") return store;

  if (store.requiresAuth) {
    if (!store.client || typeof store.client.rpc !== "function") {
      throw new Error("Authenticated store does not expose a Supabase RPC client");
    }
    store.listMapScenes = async (campaignId, context) => {
      requireAuth(context);
      return store.client.rpc("dnd_ai_map_scenes", {
        p_campaign_id: campaignId,
      }, context.token);
    };
    store.getMapScene = async (campaignId, sceneId, context) => {
      requireAuth(context);
      return store.client.rpc("dnd_ai_map_scene", {
        p_campaign_id: campaignId,
        p_scene_id: sceneId,
      }, context.token);
    };
    store.saveMapScene = async (campaignId, value, sourceMap, context) => {
      requireAuth(context);
      const input = validateMapSceneSaveRequest(value);
      const validatedSourceMap = sourceMapFor(input, sourceMap);
      return store.client.rpc("dnd_ai_save_map_scene", {
        p_campaign_id: campaignId,
        p_scene_id: input.expectedRevision === 0 ? null : input.sceneId,
        p_name: input.name,
        p_source_map: validatedSourceMap,
        p_gm_scene: input.gmScene,
        p_player_scene: input.playerScene,
        p_expected_revision: input.expectedRevision,
      }, context.token);
    };
    store.approveMapScene = async (campaignId, sceneId, value, context) => {
      requireAuth(context);
      const input = validateMapSceneApprovalRequest(value);
      return store.client.rpc("dnd_ai_approve_map_scene", {
        p_campaign_id: campaignId,
        p_scene_id: sceneId,
        p_expected_revision: input.expectedRevision,
      }, context.token);
    };
    return store;
  }

  const state = new Map();

  store.listMapScenes = async (campaignId, context = null) => {
    const manager = canManage(context);
    const records = campaignRecords(state, campaignId)
      .filter((record) => manager || record.approvedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      role: manager ? "dm" : context.localRole,
      canManage: manager,
      scenes: records.map((record) => ({
        id: record.id,
        name: record.name,
        revision: record.revision,
        approved: Boolean(record.approvedAt),
        approvedAt: record.approvedAt,
        updatedAt: record.updatedAt,
        schemaVersion: record.gmScene.schemaVersion,
        mapType: record.gmScene.mapType,
        levelCount: record.gmScene.levels.length,
      })),
    };
  };

  store.getMapScene = async (campaignId, sceneId, context = null) => {
    const record = campaignRecords(state, campaignId).find((item) => item.id === sceneId && item.active);
    return record ? localSceneRecord(record, context) : null;
  };

  store.saveMapScene = async (campaignId, value, sourceMap, context = null) => {
    if (!canManage(context)) throw forbidden();
    const input = validateMapSceneSaveRequest(value);
    const validatedSourceMap = sourceMapFor(input, sourceMap);
    const records = campaignRecords(state, campaignId);
    const creating = input.expectedRevision === 0;
    let record = creating
      ? null
      : records.find((item) => item.id === input.sceneId && item.active);
    if (!creating && !input.sceneId) throw validation("sceneId is required when revising a map scene", "sceneId");
    if (!creating && !record) throw notFound("Map scene not found");
    const now = new Date().toISOString();
    if (!record) {
      record = {
        id: randomUUID(),
        campaignId,
        createdAt: now,
        active: true,
      };
      records.push(record);
    } else if (record.revision !== input.expectedRevision) {
      throw conflict("Map scene changed; reload before saving");
    }
    Object.assign(record, {
      name: input.name,
      sourceMap: validatedSourceMap,
      gmScene: structuredClone(input.gmScene),
      playerScene: structuredClone(input.playerScene),
      revision: input.expectedRevision + 1,
      approvedBy: null,
      approvedAt: null,
      metadata: {
        sourceMapHash: input.gmScene.sourceMapHash,
      },
      updatedAt: now,
    });
    return localSceneRecord(record, context);
  };

  store.approveMapScene = async (campaignId, sceneId, value, context = null) => {
    if (!canManage(context)) throw forbidden();
    const input = validateMapSceneApprovalRequest(value);
    const record = campaignRecords(state, campaignId).find((item) => item.id === sceneId && item.active);
    if (!record) throw notFound("Map scene not found");
    if (record.revision !== input.expectedRevision) {
      throw conflict("Map scene changed; reload before approving");
    }
    record.approvedBy = context?.user?.id ?? "local-manager";
    record.approvedAt = new Date().toISOString();
    record.updatedAt = record.approvedAt;
    return localSceneRecord(record, context);
  };

  return store;
}
