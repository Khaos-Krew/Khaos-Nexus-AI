const GENERATION_METHODS = [
  "generateTurn",
  "generateHomebrew",
  "generateMap",
  "generateSessionIntelligence",
  "generateCoDmDraft",
];

function sanitizedProviderError(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const providerStatus = Number.isInteger(error?.providerStatus)
    ? error.providerStatus
    : /failed \((\d{3})\)/i.exec(error?.message ?? "")?.[1];
  const normalizedStatus = providerStatus ? Number(providerStatus) : status;
  const unavailable = normalizedStatus === 429 || (normalizedStatus >= 500 && normalizedStatus <= 599)
    || error?.name === "TimeoutError" || error?.name === "AbortError";
  const value = new Error(unavailable
    ? "The AI provider is temporarily unavailable"
    : "The AI provider could not complete the request");
  value.name = "ProviderError";
  value.status = unavailable ? 503 : 502;
  value.code = unavailable ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REQUEST_FAILED";
  value.providerStatus = normalizedStatus ?? null;
  return value;
}

export function withSafeProviderErrors(provider) {
  if (!provider || typeof provider !== "object") throw new Error("AI provider is required");
  if (provider.safeProviderErrorsEnabled) return provider;
  for (const method of GENERATION_METHODS) {
    if (typeof provider[method] !== "function") continue;
    const original = provider[method].bind(provider);
    provider[method] = async (...args) => {
      try {
        return await original(...args);
      } catch (error) {
        if (Number.isInteger(error?.status) && error.status < 500 && !/OpenAI|provider/i.test(error?.message ?? "")) {
          throw error;
        }
        throw sanitizedProviderError(error);
      }
    };
  }
  provider.safeProviderErrorsEnabled = true;
  return provider;
}
