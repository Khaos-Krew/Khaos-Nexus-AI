import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "./map-scenes.js";
import { runEvaluationSuite } from "./evaluations.js";
import {
  generationMaxOutputTokens,
  productionContext,
  providerUsage,
  recordProviderUsage,
  setGenerationPolicy,
  updateProductionContext,
} from "./production-context.js";

const PROMPTS = {
  generateTurn: { feature: "campaign.turn", promptId: "dnd-turn", promptVersion: "1", contract: "agency-secrets-safety-structured-turn-v1", categories: ["player_agency", "secret_leakage", "lore_consistency", "mechanics", "copyright", "latency", "cost"] },
  generateHomebrew: { feature: "homebrew.generate", promptId: "dnd-homebrew", promptVersion: "1", contract: "originality-balance-provenance-v1", categories: ["homebrew_balance", "copyright", "latency", "cost"] },
  generateMap: { feature: "map.generate", promptId: "dnd-map", promptVersion: "1", contract: "original-map-coordinates-v1", categories: ["copyright", "latency", "cost"] },
  generateSessionIntelligence: { feature: "session.intelligence", promptId: "dnd-session-intelligence", promptVersion: "1", contract: "gm-player-recap-canon-contradictions-v1", categories: ["secret_leakage", "lore_consistency", "copyright", "latency", "cost"] },
  generateCoDmDraft: { feature: "co_dm.draft", promptId: "dnd-co-dm-draft", promptVersion: "1", contract: "stateless-explicit-user-no-tools-no-storage-v1", categories: ["player_agency", "secret_leakage", "lore_consistency", "copyright", "latency", "cost"] },
};

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function promptDescriptor(method) {
  const value = PROMPTS[method];
  return { ...value, promptHash: hash(`${value.promptId}:${value.promptVersion}:${value.contract}`) };
}

export const generationPromptRegistry = Object.freeze(
  Object.fromEntries(Object.entries(PROMPTS).map(([method]) => [method, Object.freeze(promptDescriptor(method))])),
);

export function defaultGenerationPolicies(provider = "mock", model = "deterministic-local") {
  return Object.values(generationPromptRegistry).map((prompt) => ({
    feature: prompt.feature,
    provider,
    modelPattern: model,
    promptId: prompt.promptId,
    promptVersion: prompt.promptVersion,
    promptHash: prompt.promptHash,
    policyVersion: "baseline-1",
    maxInputTokens: 128_000,
    maxOutputTokens: 8_000,
    inputCostMicrosPerMillion: 0,
    outputCostMicrosPerMillion: 0,
    active: true,
  }));
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(canonicalJson(value).length / 4));
}

function errorCode(error) {
  if (error?.status === 429) return "BUDGET_EXCEEDED";
  if (error?.name === "AbortError" || /timeout/i.test(error?.message ?? "")) return "TIMEOUT";
  if (/refus/i.test(error?.message ?? "")) return "PROVIDER_REFUSAL";
  if (/failed \(4\d\d\)/i.test(error?.message ?? "")) return "PROVIDER_REQUEST";
  if (/failed \(5\d\d\)/i.test(error?.message ?? "")) return "PROVIDER_UNAVAILABLE";
  return "GENERATION_FAILED";
}

function monitoringEvaluationSummary(report) {
  return {
    suiteVersion: report.suiteVersion,
    outcome: report.outcome,
    summary: { ...report.summary },
    categories: report.results.map((entry) => ({ category: entry.category, outcome: entry.outcome })),
  };
}

function buildEvaluationArtifact(method, args, output, latencyMs, costMicros) {
  if (method === "generateTurn") {
    const [campaign, request] = args;
    return {
      input: request,
      output,
      publicOutput: output,
      secrets: campaign?.notes?.filter((item) => /^secret:/i.test(item)).map((item) => item.replace(/^secret:\s*/i, "")) ?? [],
      checks: output?.suggestedChecks ?? [],
      latencyMs,
      costMicros,
    };
  }
  if (method === "generateHomebrew") return { input: args[0], requestText: args[0]?.concept, output, homebrew: output, latencyMs, costMicros };
  if (method === "generateCoDmDraft") {
    const request = args[0] ?? {};
    const secrets = String(request.context?.text ?? "").split(/\r?\n/).filter((line) => /^\s*secret:/i.test(line)).map((line) => line.replace(/^\s*secret:\s*/i, ""));
    return {
      input: request,
      requestText: request.prompt,
      output,
      publicOutput: output?.content ?? "",
      secrets,
      latencyMs,
      costMicros,
    };
  }
  if (method === "generateSessionIntelligence") {
    return {
      input: args[1],
      output,
      publicOutput: output?.playerRecap ?? "",
      secrets: [output?.gmRecap, ...(output?.unresolvedThreads ?? []).filter((item) => item?.visibility === "gm").map((item) => item?.summary)].filter(Boolean),
      contradictions: output?.contradictions?.filter((item) => item?.severity === "error").map((item) => item?.summary) ?? [],
      loreWarnings: output?.contradictions?.filter((item) => item?.severity !== "error").map((item) => item?.summary) ?? [],
      latencyMs,
      costMicros,
    };
  }
  return { input: args[0], requestText: args[0]?.prompt, output, latencyMs, costMicros };
}

function extractStructuredOutput(body) {
  if (!body || typeof body !== "object") throw new Error("OpenAI returned an invalid response");
  if (typeof body.output_text === "string") return body.output_text;
  const parts = [];
  for (const item of Array.isArray(body.output) ? body.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
      if (content?.type === "refusal" && typeof content.refusal === "string") {
        throw new Error(`OpenAI refused the request: ${content.refusal}`);
      }
    }
  }
  if (!parts.length) throw new Error("OpenAI response did not include output text");
  return parts.join("\n");
}

function instrumentOpenAiProvider(provider) {
  if (provider.name !== "openai" || typeof provider.requestStructured !== "function" || provider.productionUsageInstrumented) return;
  provider.requestStructured = async ({ instructions, input, name, description, schema }) => {
    const maxOutputTokens = generationMaxOutputTokens();
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model,
        store: false,
        instructions,
        input: JSON.stringify(input),
        ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
        text: { format: { type: "json_schema", name, description, strict: true, schema } },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(`OpenAI request failed (${response.status}): ${detail}`);
    }
    const body = await response.json();
    recordProviderUsage({
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      totalTokens: body.usage?.total_tokens ?? 0,
      cachedInputTokens: body.usage?.input_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: body.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      providerRequestId: body.id ?? "",
    });
    return JSON.parse(extractStructuredOutput(body));
  };
  provider.productionUsageInstrumented = true;
}

function generationContextFor(method, args) {
  const current = productionContext() ?? {};
  let campaignId = current.campaignId ?? null;
  if (!campaignId && method === "generateTurn") campaignId = args[0]?.id ?? null;
  if (!campaignId && method === "generateSessionIntelligence") campaignId = args[0]?.campaign?.id ?? args[0]?.campaignId ?? null;
  const requestId = current.requestId ?? randomUUID();
  updateProductionContext({ requestId, campaignId });
  return { ...current, requestId, campaignId };
}

function blockedError(reason) {
  const error = new Error(`Generation blocked by production controls: ${reason}`);
  error.status = 429;
  error.code = "GENERATION_BLOCKED";
  return error;
}

export function withProductionControls(provider, store) {
  if (!provider || !store) throw new Error("provider and store are required");
  if (provider.productionControlsEnabled) return provider;
  instrumentOpenAiProvider(provider);

  for (const method of Object.keys(PROMPTS)) {
    if (typeof provider[method] !== "function") continue;
    const original = provider[method].bind(provider);
    const prompt = generationPromptRegistry[method];
    provider[method] = async (...args) => {
      const context = generationContextFor(method, args);
      const estimatedInputTokens = estimateTokens(args);
      const requestedOutputTokens = Math.min(8_000, Math.max(256, Number(args.at(-1)?.maxOutputTokens ?? 4_000)));
      const inputHash = hash(args);
      const reservation = await store.reserveGeneration({
        requestId: context.requestId,
        campaignId: context.campaignId,
        feature: prompt.feature,
        provider: provider.name,
        model: provider.model,
        promptId: prompt.promptId,
        promptVersion: prompt.promptVersion,
        promptHash: prompt.promptHash,
        estimatedInputTokens,
        reservedOutputTokens: requestedOutputTokens,
        inputHash,
      }, { token: context.token, user: context.userId ? { id: context.userId } : null, userId: context.userId });
      if (!reservation?.allowed) throw blockedError(reservation?.reason ?? "policy_denied");
      setGenerationPolicy(reservation.policy);
      const started = Date.now();
      try {
        const output = await original(...args);
        const latencyMs = Date.now() - started;
        const measured = providerUsage();
        const inputTokens = measured?.inputTokens || estimatedInputTokens;
        const outputTokens = measured?.outputTokens || estimateTokens(output);
        const costMicros = Math.ceil(
          ((inputTokens * (reservation.policy?.inputCostMicrosPerMillion ?? 0))
            + (outputTokens * (reservation.policy?.outputCostMicrosPerMillion ?? 0))) / 1_000_000,
        );
        const report = runEvaluationSuite(
          buildEvaluationArtifact(method, args, output, latencyMs, costMicros),
          prompt.categories,
        );
        const outputHash = hash(output);
        await store.finalizeGeneration({
          requestId: context.requestId,
          status: "succeeded",
          inputTokens,
          outputTokens,
          cachedInputTokens: measured?.cachedInputTokens ?? 0,
          reasoningTokens: measured?.reasoningTokens ?? 0,
          latencyMs,
          outputHash,
          providerRequestId: measured?.providerRequestId ?? "",
          errorCode: null,
          evaluationSummary: monitoringEvaluationSummary(report),
        }, { token: context.token, user: context.userId ? { id: context.userId } : null });
        if (typeof store.saveEvaluationRun === "function") {
          await store.saveEvaluationRun({
            campaignId: context.campaignId,
            feature: prompt.feature,
            suiteVersion: report.suiteVersion,
            artifactHash: outputHash,
            outcome: report.outcome,
            report,
          }, { token: context.token, user: context.userId ? { id: context.userId } : null }).catch(() => {});
        }
        return output;
      } catch (error) {
        const measured = providerUsage();
        await store.finalizeGeneration({
          requestId: context.requestId,
          status: "failed",
          inputTokens: measured?.inputTokens ?? 0,
          outputTokens: measured?.outputTokens ?? 0,
          cachedInputTokens: measured?.cachedInputTokens ?? 0,
          reasoningTokens: measured?.reasoningTokens ?? 0,
          latencyMs: Date.now() - started,
          outputHash: null,
          providerRequestId: measured?.providerRequestId ?? "",
          errorCode: errorCode(error),
          evaluationSummary: {},
        }, { token: context.token, user: context.userId ? { id: context.userId } : null }).catch(() => {});
        throw error;
      } finally {
        setGenerationPolicy(null);
      }
    };
  }
  provider.productionControlsEnabled = true;
  provider.promptRegistry = generationPromptRegistry;
  return provider;
}
