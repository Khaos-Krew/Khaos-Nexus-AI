import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

function active() {
  return storage.getStore() ?? null;
}

export function runWithProductionContext(context, callback) {
  const parent = active() ?? {};
  return storage.run({
    requestId: context.requestId ?? parent.requestId ?? null,
    userId: context.userId ?? parent.userId ?? null,
    campaignId: context.campaignId ?? parent.campaignId ?? null,
    tenantId: context.tenantId ?? parent.tenantId ?? null,
    token: context.token ?? parent.token ?? null,
    path: context.path ?? parent.path ?? "",
    providerUsage: null,
    policy: null,
  }, callback);
}

export function productionContext() {
  return active();
}

export function updateProductionContext(patch) {
  const context = active();
  if (context) Object.assign(context, patch);
  return context;
}

export function recordProviderUsage(usage) {
  const context = active();
  if (!context) return;
  context.providerUsage = {
    inputTokens: Number.isInteger(usage?.inputTokens) ? Math.max(0, usage.inputTokens) : 0,
    outputTokens: Number.isInteger(usage?.outputTokens) ? Math.max(0, usage.outputTokens) : 0,
    totalTokens: Number.isInteger(usage?.totalTokens) ? Math.max(0, usage.totalTokens) : 0,
    cachedInputTokens: Number.isInteger(usage?.cachedInputTokens) ? Math.max(0, usage.cachedInputTokens) : 0,
    reasoningTokens: Number.isInteger(usage?.reasoningTokens) ? Math.max(0, usage.reasoningTokens) : 0,
    providerRequestId: typeof usage?.providerRequestId === "string" ? usage.providerRequestId.slice(0, 200) : "",
  };
}

export function providerUsage() {
  return active()?.providerUsage ?? null;
}

export function setGenerationPolicy(policy) {
  const context = active();
  if (context) context.policy = policy ?? null;
}

export function generationPolicy() {
  return active()?.policy ?? null;
}

export function generationMaxOutputTokens() {
  const value = generationPolicy()?.maxOutputTokens;
  return Number.isInteger(value) && value > 0 ? value : null;
}
