import { MockAiProvider, OpenAiProvider } from "./ai.js";
import { createApp } from "./app.js";
import { attachCoDmRoutes } from "./co-dm-http.js";
import { withCoDmDraft } from "./co-dm.js";
import { LocalDiscordBridge, SupabaseDiscordBridge } from "./discord-adapters.js";
import { attachDiscordRoutes } from "./discord-http.js";
import { attachDiscordSecurity } from "./discord-security.js";
import { LocalEncounterEngine } from "./encounter-engine.js";
import { configureHttpServer, logInternalError } from "./http-security.js";
import { withLaunchControlStore } from "./launch-control-store.js";
import { attachLaunchContext } from "./launch-context.js";
import { attachMapSceneDiscordRoutes } from "./map-scene-discord.js";
import { attachMapSceneRoutes } from "./map-scene-http.js";
import { withMapSceneStore } from "./map-scene-store.js";
import { attachProductionControlRoutes } from "./production-control-http.js";
import { withProductionControlStore } from "./production-control-store.js";
import { defaultGenerationPolicies, withProductionControls } from "./production-controls.js";
import { withSafeProviderErrors } from "./provider-safety.js";
import { attachRetrievalRoutes } from "./retrieval-http.js";
import { withRetrievalStore } from "./retrieval-store.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { SafeSupabaseAuthVerifier, SafeSupabaseRestClient } from "./safe-supabase.js";
import { attachSessionIntelligenceRoutes } from "./session-intelligence-http.js";
import { withSessionIntelligence } from "./session-intelligence-provider.js";
import { withSessionIntelligenceStore } from "./session-intelligence-store.js";
import { JsonCampaignStore } from "./store.js";
import { SupabaseCampaignStore } from "./supabase.js";

const SERVICE_VERSION = "0.12.1";
const config = loadRuntimeConfig(process.env);

function createBaseProvider() {
  if (config.provider === "mock") {
    return withCoDmDraft(withSessionIntelligence(new MockAiProvider()));
  }
  return withCoDmDraft(withSessionIntelligence(new OpenAiProvider(
    config.openAiApiKey,
    config.openAiModel,
    config.openAiBaseUrl,
  )));
}

function decorateCampaignStore(store) {
  return withMapSceneStore(withRetrievalStore(withSessionIntelligenceStore(store)));
}

function createPersistence() {
  if (config.store === "json") {
    const store = decorateCampaignStore(new JsonCampaignStore(config.dataDir));
    const discordBridge = new LocalDiscordBridge();
    if (!config.authRequired) {
      return { store, discordBridge, authVerifier: null, authRequired: false };
    }
    const authVerifier = new SafeSupabaseAuthVerifier({
      url: config.supabaseUrl,
      publishableKey: config.supabasePublishableKey,
    });
    return { store, discordBridge, authVerifier, authRequired: true };
  }

  const supabaseConfig = {
    url: config.supabaseUrl,
    publishableKey: config.supabasePublishableKey,
  };
  const client = new SafeSupabaseRestClient(supabaseConfig);
  return {
    store: decorateCampaignStore(new SupabaseCampaignStore(client)),
    discordBridge: new SupabaseDiscordBridge(client),
    authVerifier: new SafeSupabaseAuthVerifier(supabaseConfig),
    authRequired: true,
  };
}

const baseProvider = createBaseProvider();
const persistence = createPersistence();
persistence.store = withLaunchControlStore(withProductionControlStore(persistence.store, {
  defaultPolicies: defaultGenerationPolicies(baseProvider.name, baseProvider.model),
}));
const provider = withSafeProviderErrors(withProductionControls(baseProvider, persistence.store));
const encounterEngine = persistence.store.requiresAuth ? null : new LocalEncounterEngine();
const sharedHttpOptions = {
  corsOrigin: config.corsOrigin,
  trustProxy: config.trustProxy,
  rateLimitMaxEntries: config.rateLimitMaxEntries,
};

const server = createApp({
  ...persistence,
  provider,
  encounterEngine,
  ...sharedHttpOptions,
});
attachCoDmRoutes(server, { ...persistence, provider, ...sharedHttpOptions });
attachSessionIntelligenceRoutes(server, { ...persistence, provider, ...sharedHttpOptions });
attachRetrievalRoutes(server, { ...persistence, ...sharedHttpOptions });
attachMapSceneRoutes(server, { ...persistence, provider, ...sharedHttpOptions });
attachDiscordRoutes(server, { ...persistence, provider, encounterEngine, ...sharedHttpOptions });
attachMapSceneDiscordRoutes(server, { ...persistence, provider, ...sharedHttpOptions });
attachDiscordSecurity(server, sharedHttpOptions);
attachProductionControlRoutes(server, {
  ...persistence,
  provider,
  ...sharedHttpOptions,
  serviceVersion: SERVICE_VERSION,
});
attachLaunchContext(server, { ...persistence, ...sharedHttpOptions });
configureHttpServer(server, config);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "service.shutdown", signal }));
  const forceTimer = setTimeout(() => {
    logInternalError(new Error("Graceful shutdown timed out"), { event: "service.shutdown.timeout" });
    process.exit(1);
  }, config.shutdownGraceMs);
  forceTimer.unref();
  server.closeIdleConnections?.();
  server.close((error) => {
    clearTimeout(forceTimer);
    if (error) {
      logInternalError(error, { event: "service.shutdown.failed" });
      process.exitCode = 1;
    }
  });
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
server.on("error", (error) => {
  logInternalError(error, { event: "service.listen.failed" });
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    level: "info",
    event: "service.listening",
    service: "khaos-nexus-ai",
    version: SERVICE_VERSION,
    host: config.host,
    port: config.port,
    provider: provider.name,
    model: provider.model,
    store: persistence.store.name,
    authentication: persistence.authRequired ? "required" : "optional",
    productionControls: true,
  }));
});
