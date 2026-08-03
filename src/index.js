import { MockAiProvider, OpenAiProvider } from "./ai.js";
import { createApp } from "./app.js";
import { LocalDiscordBridge, SupabaseDiscordBridge } from "./discord-adapters.js";
import { attachDiscordRoutes } from "./discord-http.js";
import { LocalEncounterEngine } from "./encounter-engine.js";
import { withSessionIntelligence } from "./session-intelligence-provider.js";
import { attachSessionIntelligenceRoutes } from "./session-intelligence-http.js";
import { withSessionIntelligenceStore } from "./session-intelligence-store.js";
import { JsonCampaignStore } from "./store.js";
import {
  SupabaseAuthVerifier,
  SupabaseCampaignStore,
  SupabaseRestClient,
} from "./supabase.js";

function booleanEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function createProvider() {
  const providerName = (process.env.AI_PROVIDER ?? "mock").toLowerCase();
  if (providerName === "mock") return withSessionIntelligence(new MockAiProvider());
  if (providerName === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
    }
    return withSessionIntelligence(new OpenAiProvider(
      process.env.OPENAI_API_KEY,
      process.env.OPENAI_MODEL ?? "gpt-5-mini",
      process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    ));
  }
  throw new Error(`Unsupported AI_PROVIDER: ${providerName}`);
}

function createPersistence() {
  const storeName = (process.env.CAMPAIGN_STORE ?? "json").toLowerCase();
  if (storeName === "json") {
    const store = withSessionIntelligenceStore(
      new JsonCampaignStore(process.env.DATA_DIR ?? "./data"),
    );
    const authRequired = booleanEnv("AUTH_REQUIRED", false);
    const discordBridge = new LocalDiscordBridge();
    if (!authRequired) {
      return { store, discordBridge, authVerifier: null, authRequired };
    }

    const authVerifier = new SupabaseAuthVerifier({
      url: process.env.SUPABASE_URL,
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    });
    return { store, discordBridge, authVerifier, authRequired };
  }

  if (storeName === "supabase") {
    const config = {
      url: process.env.SUPABASE_URL,
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    };
    const client = new SupabaseRestClient(config);
    return {
      store: withSessionIntelligenceStore(new SupabaseCampaignStore(client)),
      discordBridge: new SupabaseDiscordBridge(client),
      authVerifier: new SupabaseAuthVerifier(config),
      authRequired: true,
    };
  }

  throw new Error(`Unsupported CAMPAIGN_STORE: ${storeName}`);
}

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const provider = createProvider();
const persistence = createPersistence();
const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";
const encounterEngine = persistence.store.requiresAuth ? null : new LocalEncounterEngine();
const server = createApp({
  ...persistence,
  provider,
  encounterEngine,
  corsOrigin,
});

attachSessionIntelligenceRoutes(server, {
  ...persistence,
  provider,
  corsOrigin,
});

attachDiscordRoutes(server, {
  ...persistence,
  provider,
  encounterEngine,
  corsOrigin,
});

server.listen(port, () => {
  console.log(
    `Khaos Nexus AI listening on http://localhost:${port} ` +
      `(${provider.name}/${provider.model}; store=${persistence.store.name}; ` +
      `auth=${persistence.authRequired ? "required" : "optional"})`,
  );
});
