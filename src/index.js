import { MockAiProvider, OpenAiProvider } from "./ai.js";
import { createApp } from "./app.js";
import { JsonCampaignStore } from "./store.js";

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

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const provider = createProvider();
const server = createApp({
  store: new JsonCampaignStore(process.env.DATA_DIR ?? "./data"),
  provider,
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
});

server.listen(port, () => {
  console.log(
    `Khaos Nexus AI listening on http://localhost:${port} (${provider.name}/${provider.model})`,
  );
});
