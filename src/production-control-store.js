import { randomUUID } from "node:crypto";

const PERIODS = ["daily", "monthly"];

function error(message, status = 400) {
  const value = new Error(message);
  value.status = status;
  return value;
}

function integerOrNull(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (!Number.isSafeInteger(value) || value < 0) throw error(`${field} must be a non-negative safe integer`);
  return value;
}

function textOrNull(value, max = 200) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw error("Expected text");
  return value.trim().slice(0, max) || null;
}

export function validateBudgetInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("body must be an object");
  const allowed = [
    "budgetId", "tenantId", "campaignId", "userId", "feature", "period", "requestLimit",
    "inputTokenLimit", "outputTokenLimit", "costLimitMicros", "active",
  ];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw error(`body.${key} is not allowed`);
  const period = value.period ?? "monthly";
  if (!PERIODS.includes(period)) throw error(`period must be one of: ${PERIODS.join(", ")}`);
  const limits = {
    requestLimit: integerOrNull(value.requestLimit, "requestLimit"),
    inputTokenLimit: integerOrNull(value.inputTokenLimit, "inputTokenLimit"),
    outputTokenLimit: integerOrNull(value.outputTokenLimit, "outputTokenLimit"),
    costLimitMicros: integerOrNull(value.costLimitMicros, "costLimitMicros"),
  };
  if (Object.values(limits).every((item) => item === null)) throw error("At least one budget limit is required");
  return {
    budgetId: textOrNull(value.budgetId, 36),
    tenantId: textOrNull(value.tenantId, 36),
    campaignId: textOrNull(value.campaignId, 36),
    userId: textOrNull(value.userId, 36),
    feature: textOrNull(value.feature, 100),
    period,
    ...limits,
    active: value.active !== false,
  };
}

export function validateModelPolicyInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("body must be an object");
  const allowed = [
    "policyId", "feature", "provider", "modelPattern", "promptId", "promptVersion",
    "promptHash", "policyVersion", "maxInputTokens", "maxOutputTokens",
    "inputCostMicrosPerMillion", "outputCostMicrosPerMillion", "active",
  ];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw error(`body.${key} is not allowed`);
  const required = ["feature", "provider", "modelPattern", "promptId", "promptVersion", "promptHash", "policyVersion"];
  for (const field of required) if (!textOrNull(value[field])) throw error(`${field} is required`);
  if (!/^[a-f0-9]{64}$/i.test(value.promptHash)) throw error("promptHash must be a SHA-256 hex digest");
  return {
    policyId: textOrNull(value.policyId, 36),
    feature: textOrNull(value.feature, 100),
    provider: textOrNull(value.provider, 80),
    modelPattern: textOrNull(value.modelPattern, 200),
    promptId: textOrNull(value.promptId, 120),
    promptVersion: textOrNull(value.promptVersion, 80),
    promptHash: value.promptHash.toLowerCase(),
    policyVersion: textOrNull(value.policyVersion, 80),
    maxInputTokens: integerOrNull(value.maxInputTokens, "maxInputTokens") ?? 128_000,
    maxOutputTokens: integerOrNull(value.maxOutputTokens, "maxOutputTokens") ?? 8_000,
    inputCostMicrosPerMillion: integerOrNull(value.inputCostMicrosPerMillion, "inputCostMicrosPerMillion") ?? 0,
    outputCostMicrosPerMillion: integerOrNull(value.outputCostMicrosPerMillion, "outputCostMicrosPerMillion") ?? 0,
    active: value.active !== false,
  };
}

function periodStart(period, now = new Date()) {
  if (period === "daily") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function matchesBudget(budget, input, context) {
  if (!budget.active) return false;
  if (budget.campaignId && budget.campaignId !== input.campaignId) return false;
  if (budget.userId && budget.userId !== context.userId) return false;
  if (budget.feature && budget.feature !== input.feature) return false;
  return true;
}

function policyMatches(policy, input) {
  return policy.active
    && policy.feature === input.feature
    && policy.provider === input.provider
    && (policy.modelPattern === "*" || policy.modelPattern === input.model)
    && policy.promptId === input.promptId
    && policy.promptVersion === input.promptVersion
    && policy.promptHash === input.promptHash;
}

function estimatedCost(input, policy) {
  return Math.ceil(
    ((input.estimatedInputTokens * policy.inputCostMicrosPerMillion)
      + (input.reservedOutputTokens * policy.outputCostMicrosPerMillion)) / 1_000_000,
  );
}

function actualCost(input, policy) {
  return Math.ceil(
    ((input.inputTokens * policy.inputCostMicrosPerMillion)
      + (input.outputTokens * policy.outputCostMicrosPerMillion)) / 1_000_000,
  );
}

function usageFor(events, budget, input, context, now = new Date()) {
  const start = periodStart(budget.period, now);
  const relevant = events.filter((entry) =>
    entry.createdAt >= start
    && entry.status !== "blocked"
    && (!budget.campaignId || entry.campaignId === input.campaignId)
    && (!budget.userId || entry.userId === context.userId)
    && (!budget.feature || entry.feature === input.feature));
  return relevant.reduce((total, entry) => ({
    requests: total.requests + 1,
    inputTokens: total.inputTokens + (entry.inputTokens ?? entry.estimatedInputTokens ?? 0),
    outputTokens: total.outputTokens + (entry.outputTokens ?? entry.reservedOutputTokens ?? 0),
    costMicros: total.costMicros + (entry.costMicros ?? entry.reservedCostMicros ?? 0),
  }), { requests: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 });
}

function budgetDecision(budget, usage, reservation) {
  const checks = [
    ["request_limit", budget.requestLimit, usage.requests + 1],
    ["input_token_limit", budget.inputTokenLimit, usage.inputTokens + reservation.estimatedInputTokens],
    ["output_token_limit", budget.outputTokenLimit, usage.outputTokens + reservation.reservedOutputTokens],
    ["cost_limit", budget.costLimitMicros, usage.costMicros + reservation.reservedCostMicros],
  ];
  const exceeded = checks.find(([, limit, next]) => limit !== null && limit !== undefined && next > limit);
  return exceeded ? { allowed: false, reason: exceeded[0], limit: exceeded[1], projected: exceeded[2] } : { allowed: true };
}

function requireAuth(context) {
  if (!context?.token || !context?.user?.id) throw error("Authentication is required", 401);
}

function localManager(context) {
  return !["player", "viewer"].includes(context?.localRole ?? "dm");
}

function requireManager(context) {
  if (!localManager(context)) throw error("Campaign management permission is required", 403);
}

export function withProductionControlStore(store, { defaultPolicies = [] } = {}) {
  if (!store || typeof store !== "object") throw new Error("Campaign store is required");
  if (typeof store.reserveGeneration === "function") return store;

  if (store.requiresAuth) {
    if (!store.client || typeof store.client.rpc !== "function") throw new Error("Authenticated store does not expose a Supabase RPC client");
    store.resolveGenerationPolicy = async (input, context) => {
      requireAuth(context);
      return store.client.rpc("dnd_ai_generation_policy", {
        p_campaign_id: input.campaignId,
        p_feature: input.feature,
        p_provider: input.provider,
        p_model: input.model,
        p_prompt_id: input.promptId,
        p_prompt_version: input.promptVersion,
        p_prompt_hash: input.promptHash,
      }, context.token);
    };
    store.reserveGeneration = async (input, context) => {
      requireAuth(context);
      return store.client.rpc("dnd_ai_reserve_generation", {
        p_request_id: input.requestId,
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
    store.finalizeGeneration = async (input, context) => {
      requireAuth(context);
      return store.client.rpc("dnd_ai_finalize_generation", {
        p_request_id: input.requestId,
        p_status: input.status,
        p_input_tokens: input.inputTokens,
        p_output_tokens: input.outputTokens,
        p_cached_input_tokens: input.cachedInputTokens,
        p_reasoning_tokens: input.reasoningTokens,
        p_latency_ms: input.latencyMs,
        p_output_hash: input.outputHash,
        p_provider_request_id: input.providerRequestId,
        p_error_code: input.errorCode,
        p_evaluation_summary: input.evaluationSummary,
      }, context.token);
    };
    store.listProductionBudgets = async (campaignId, context) => {
      requireAuth(context);
      return store.client.rpc("dnd_ai_budgets", { p_campaign_id: campaignId }, context.token);
    };
    store.upsertProductionBudget = async (value, context) => {
      requireAuth(context);
      const input = validateBudgetInput(value);
      return store.client.rpc("dnd_ai_upsert_budget", {
        p_budget_id: input.budgetId,
        p_tenant_id: input.tenantId,
        p_campaign_id: input.campaignId,
        p_user_id: input.userId,
        p_feature: input.feature,
        p_period: input.period,
        p_request_limit: input.requestLimit,
        p_input_token_limit: input.inputTokenLimit,
        p_output_token_limit: input.outputTokenLimit,
        p_cost_limit_micros: input.costLimitMicros,
        p_active: input.active,
      }, context.token);
    };
    store.listModelPolicies = async (campaignId, context) => {
      requireAuth(context);
      return store.client.rpc("dnd_ai_model_policies", { p_campaign_id: campaignId }, context.token);
    };
    store.upsertModelPolicy = async (value, campaignId, context) => {
      requireAuth(context);
      const input = validateModelPolicyInput(value);
      return store.client.rpc("dnd_ai_upsert_model_policy", {
        p_policy_id: input.policyId,
        p_campaign_id: campaignId,
        p_feature: input.feature,
        p_provider: input.provider,
        p_model_pattern: input.modelPattern,
        p_prompt_id: input.promptId,
        p_prompt_version: input.promptVersion,
        p_prompt_hash: input.promptHash,
        p_policy_version: input.policyVersion,
        p_max_input_tokens: input.maxInputTokens,
        p_max_output_tokens: input.maxOutputTokens,
        p_input_cost_micros_per_million: input.inputCostMicrosPerMillion,
        p_output_cost_micros_per_million: input.outputCostMicrosPerMillion,
        p_active: input.active,
      }, context.token);
    };
    store.listProductionUsage = async (campaignId, limit, context) => {
      requireAuth(context);
      return store.client.rpc("dnd_ai_usage", { p_campaign_id: campaignId, p_limit: limit }, context.token);
    };
    store.saveEvaluationRun = async (input, context) => {
      requireAuth(context);
      return store.client.rpc("dnd_ai_save_evaluation", {
        p_campaign_id: input.campaignId,
        p_feature: input.feature,
        p_suite_version: input.suiteVersion,
        p_artifact_hash: input.artifactHash,
        p_outcome: input.outcome,
        p_report: input.report,
      }, context.token);
    };
    store.listEvaluationRuns = async (campaignId, limit, context) => {
      requireAuth(context);
      return store.client.rpc("dnd_ai_evaluations", { p_campaign_id: campaignId, p_limit: limit }, context.token);
    };
    return store;
  }

  const policies = defaultPolicies.map((policy) => ({ ...policy, id: policy.id ?? randomUUID(), createdAt: new Date().toISOString() }));
  const budgets = [];
  const events = [];
  const evaluations = [];

  store.resolveGenerationPolicy = async (input) => {
    const candidates = policies.filter((policy) => policyMatches(policy, input));
    const policy = candidates.sort((a, b) => (a.modelPattern === input.model ? -1 : 1))[0] ?? null;
    return { allowed: Boolean(policy), reason: policy ? null : "model_policy_not_found", policy };
  };

  store.reserveGeneration = async (input, context = null) => {
    const existing = events.find((entry) => entry.requestId === input.requestId);
    if (existing) return { allowed: existing.status !== "blocked", reason: existing.blockReason ?? null, event: structuredClone(existing), policy: existing.policy };
    const resolved = await store.resolveGenerationPolicy(input, context);
    if (!resolved.allowed) {
      const blocked = {
        id: randomUUID(), requestId: input.requestId, campaignId: input.campaignId ?? null,
        userId: context?.user?.id ?? context?.userId ?? "local-user", feature: input.feature,
        provider: input.provider, model: input.model, promptId: input.promptId,
        promptVersion: input.promptVersion, promptHash: input.promptHash, inputHash: input.inputHash,
        status: "blocked", blockReason: resolved.reason, createdAt: new Date().toISOString(), policy: null,
      };
      events.push(blocked);
      return { allowed: false, reason: resolved.reason, event: structuredClone(blocked), policy: null };
    }
    const policy = resolved.policy;
    if (input.estimatedInputTokens > policy.maxInputTokens) return { allowed: false, reason: "max_input_tokens", policy };
    if (input.reservedOutputTokens > policy.maxOutputTokens) return { allowed: false, reason: "max_output_tokens", policy };
    const reservation = { ...input, reservedCostMicros: estimatedCost(input, policy) };
    for (const budget of budgets.filter((entry) => matchesBudget(entry, input, context ?? {}))) {
      const usage = usageFor(events, budget, input, context ?? {});
      const decision = budgetDecision(budget, usage, reservation);
      if (!decision.allowed) {
        const blocked = {
          id: randomUUID(), requestId: input.requestId, campaignId: input.campaignId ?? null,
          userId: context?.user?.id ?? context?.userId ?? "local-user", feature: input.feature,
          provider: input.provider, model: input.model, promptId: input.promptId,
          promptVersion: input.promptVersion, promptHash: input.promptHash, inputHash: input.inputHash,
          status: "blocked", blockReason: decision.reason, budgetId: budget.id,
          createdAt: new Date().toISOString(), policy,
        };
        events.push(blocked);
        return { allowed: false, reason: decision.reason, budgetId: budget.id, event: structuredClone(blocked), policy };
      }
    }
    const event = {
      id: randomUUID(), requestId: input.requestId, campaignId: input.campaignId ?? null,
      userId: context?.user?.id ?? context?.userId ?? "local-user", feature: input.feature,
      provider: input.provider, model: input.model, promptId: input.promptId,
      promptVersion: input.promptVersion, promptHash: input.promptHash, inputHash: input.inputHash,
      estimatedInputTokens: input.estimatedInputTokens,
      reservedOutputTokens: input.reservedOutputTokens,
      reservedCostMicros: reservation.reservedCostMicros,
      status: "reserved", createdAt: new Date().toISOString(), policy,
    };
    events.push(event);
    return { allowed: true, event: structuredClone(event), policy: structuredClone(policy) };
  };

  store.finalizeGeneration = async (input) => {
    const event = events.find((entry) => entry.requestId === input.requestId);
    if (!event) throw error("Usage reservation not found", 404);
    if (["succeeded", "failed"].includes(event.status) || event.status === "blocked") return structuredClone(event);
    Object.assign(event, {
      status: input.status,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedInputTokens: input.cachedInputTokens,
      reasoningTokens: input.reasoningTokens,
      latencyMs: input.latencyMs,
      outputHash: input.outputHash,
      providerRequestId: input.providerRequestId,
      errorCode: input.errorCode,
      evaluationSummary: structuredClone(input.evaluationSummary ?? {}),
      costMicros: actualCost(input, event.policy),
      finalizedAt: new Date().toISOString(),
    });
    return structuredClone(event);
  };

  store.listProductionBudgets = async () => ({ canManage: true, budgets: structuredClone(budgets) });
  store.upsertProductionBudget = async (value, context = null) => {
    requireManager(context);
    const input = validateBudgetInput(value);
    let budget = input.budgetId ? budgets.find((item) => item.id === input.budgetId) : null;
    if (!budget) {
      budget = { id: randomUUID(), createdAt: new Date().toISOString() };
      budgets.push(budget);
    }
    Object.assign(budget, input, { budgetId: undefined, updatedAt: new Date().toISOString() });
    return structuredClone(budget);
  };
  store.listModelPolicies = async () => ({ canManage: true, policies: structuredClone(policies) });
  store.upsertModelPolicy = async (value, campaignId, context = null) => {
    requireManager(context);
    const input = validateModelPolicyInput(value);
    let policy = input.policyId ? policies.find((item) => item.id === input.policyId) : null;
    if (!policy) {
      policy = { id: randomUUID(), campaignId: campaignId ?? null, createdAt: new Date().toISOString() };
      policies.push(policy);
    }
    Object.assign(policy, input, { policyId: undefined, updatedAt: new Date().toISOString() });
    return structuredClone(policy);
  };
  store.listProductionUsage = async (campaignId, limit = 100) => {
    const rows = events.filter((entry) => !campaignId || entry.campaignId === campaignId).slice(-limit).reverse();
    const summary = rows.reduce((total, entry) => ({
      requests: total.requests + (entry.status === "blocked" ? 0 : 1),
      blocked: total.blocked + (entry.status === "blocked" ? 1 : 0),
      inputTokens: total.inputTokens + (entry.inputTokens ?? 0),
      outputTokens: total.outputTokens + (entry.outputTokens ?? 0),
      costMicros: total.costMicros + (entry.costMicros ?? 0),
    }), { requests: 0, blocked: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 });
    return { canManage: true, summary, events: structuredClone(rows) };
  };
  store.saveEvaluationRun = async (input) => {
    const record = { id: randomUUID(), ...structuredClone(input), createdAt: new Date().toISOString() };
    evaluations.push(record);
    return structuredClone(record);
  };
  store.listEvaluationRuns = async (campaignId, limit = 100) => ({
    canManage: true,
    evaluations: structuredClone(evaluations.filter((entry) => !campaignId || entry.campaignId === campaignId).slice(-limit).reverse()),
  });

  return store;
}
