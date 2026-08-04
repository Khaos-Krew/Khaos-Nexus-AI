import { productionContext } from "./production-context.js";

function requireAuthenticatedContext(context) {
  if (!context?.token || !context?.user?.id) {
    const error = new Error("Authentication is required");
    error.status = 401;
    throw error;
  }
}

export function withLaunchControlStore(store) {
  if (!store || typeof store !== "object") throw new Error("Campaign store is required");
  if (!store.requiresAuth || store.launchControlStoreEnabled) return store;
  if (!store.client || typeof store.client.rpc !== "function") {
    throw new Error("Authenticated store does not expose a Supabase RPC client");
  }

  store.reserveGeneration = async (input, context) => {
    requireAuthenticatedContext(context);
    const tenantId = context.tenantId ?? productionContext()?.tenantId ?? null;
    return store.client.rpc("dnd_ai_reserve_generation_v2", {
      p_request_id: input.requestId,
      p_tenant_id: tenantId,
      p_campaign_id: input.campaignId,
      p_feature: input.feature,
      p_provider: input.provider,
      p_model: input.model,
      p_prompt_id: input.promptId,
      p_prompt_version: input.promptVersion,
      p_prompt_hash: input.promptHash,
      p_estimated_input_tokens: input.estimatedInputTokens,
      p_reserved_output_tokens: input.reservedOutputTokens,
      p_input_hash: input.inputHash,
    }, context.token);
  };
  store.launchControlStoreEnabled = true;
  return store;
}
