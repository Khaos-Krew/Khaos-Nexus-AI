import { MockAiProvider, OpenAiProvider } from "./ai.js";
import { createApp } from "./app.js";
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
  if (providerName === "mock") return new MockAiProvider();
  if (providerName === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
    }
    return new OpenAiProvider(
      process.env.OPENAI_API_KEY,
      process.env.OPENAI_MODEL ?? "gpt-5-mini",
      process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    );
  }
  throw new Error(`Unsupported AI_PROVIDER: ${providerName}`);
}

function createPersistence() {
  const storeName = (process.env.CAMPAIGN_STORE ?? "json").toLowerCase();
  if (storeName === "json") {
    const store = new JsonCampaignStore(process.env.DATA_DIR ?? "./data");
    const authRequired = booleanEnv("AUTH_REQUIRED", false);
    if (!authRequired) return { store, authVerifier: null, authRequired };

    const authVerifier = new SupabaseAuthVerifier({
      url: process.env.SUPABASE_URL,
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    });
    return { store, authVerifier, authRequired };
  }

  if (storeName === "supabase") {
    const config = {
      url: process.env.SUPABASE_URL,
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    };
    const client = new SupabaseRestClient(config);
    return {
      store: new SupabaseCampaignStore(client),
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
const server = createApp({
  ...persistence,
  provider,
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
});

server.listen(port, () => {
  console.log(
    `Khaos Nexus AI listening on http://localhost:${port} ` +
      `(${provider.name}/${provider.model}; store=${persistence.store.name}; ` +
      `auth=${persistence.authRequired ? "required" : "optional"})`,
  );
});
