import { turnResultJsonSchema, validateTurnResult } from "./domain.js";

function buildInstructions(campaign) {
  return [
    "You are Khaos Nexus AI, a careful tabletop fantasy Game Master and Co-DM.",
    `Operate in ${campaign.mode === "gm" ? "Game Master" : "Co-DM"} mode.`,
    "Preserve player agency. Never decide a player character's thoughts, dialogue, or irreversible action.",
    "Do not invent a successful outcome before a required roll is resolved.",
    "Use only campaign-provided lore and rules notes. When a rule is uncertain, label it as a ruling suggestion.",
    "Keep secret information out of narration unless the player action reveals it.",
    "Honor lines, veils, pause words, and the selected content rating.",
    "Return concise scene-forward narration, optional checks, 2-4 useful choices, and minimal state updates.",
    "Do not quote or reconstruct non-provided copyrighted rulebook text.",
  ].join("\n");
}

function buildInput(campaign, request) {
  return {
    campaign: {
      name: campaign.name,
      system: campaign.system,
      mode: campaign.mode,
      tone: campaign.tone,
      contentRating: campaign.contentRating,
      lore: campaign.lore,
      rulesNotes: campaign.rulesNotes,
      playerCharacters: campaign.playerCharacters,
      safety: campaign.safety,
    },
    state: {
      currentScene: campaign.currentScene,
      worldFacts: campaign.worldFacts.slice(-50),
      openThreads: campaign.openThreads.slice(-30),
      notes: campaign.notes.slice(-30),
      recentTranscript: campaign.transcript.slice(-8).map((entry) => ({
        actor: entry.actor,
        input: entry.input,
        narration: entry.result.narration,
      })),
    },
    turn: request,
  };
}

function extractOutputText(body) {
  if (!body || typeof body !== "object") throw new Error("OpenAI returned an invalid response");
  if (typeof body.output_text === "string") return body.output_text;
  const parts = [];
  for (const item of Array.isArray(body.output) ? body.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  if (parts.length === 0) throw new Error("OpenAI response did not include output text");
  return parts.join("\n");
}

export class OpenAiProvider {
  constructor(apiKey, model, baseUrl = "https://api.openai.com/v1") {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.name = "openai";
  }

  async generateTurn(campaign, request) {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        store: false,
        instructions: buildInstructions(campaign),
        input: JSON.stringify(buildInput(campaign, request)),
        text: {
          format: {
            type: "json_schema",
            name: "dnd_turn",
            description: "A structured D&D Game Master or Co-DM turn.",
            strict: true,
            schema: turnResultJsonSchema,
          },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      throw new Error(`OpenAI request failed (${response.status}): ${detail}`);
    }
    return validateTurnResult(JSON.parse(extractOutputText(await response.json())));
  }
}

export class MockAiProvider {
  constructor() {
    this.name = "mock";
    this.model = "deterministic-local";
  }

  async generateTurn(campaign, request) {
    const lower = request.message.toLowerCase();
    const asksForSearch = /search|inspect|investigate|look around/.test(lower);
    const asksForPause = campaign.safety.pauseWords.some((word) =>
      lower.includes(word.toLowerCase()),
    );

    if (asksForPause) {
      return {
        narration: "The scene pauses immediately. No further story action is taken.",
        spokenDialogue: [],
        suggestedChecks: [],
        choices: ["Resume when everyone is ready", "Change the scene", "Review safety limits"],
        stateUpdates: {
          currentScene: campaign.currentScene,
          addWorldFacts: [],
          addOpenThreads: [],
          resolveOpenThreads: [],
          addNotes: ["A safety pause was requested."],
        },
        safety: { status: "pause", reason: "A configured pause word was used." },
      };
    }

    return {
      narration: `${request.actor} acts: ${request.message} The world responds with a new complication while leaving the final outcome open to the table.`,
      spokenDialogue: [
        {
          speaker: "Nearby guide",
          text: "Choose carefully. Something here is not what it first appears to be.",
        },
      ],
      suggestedChecks: asksForSearch
        ? [
            {
              character: request.actor,
              ability: "Wisdom",
              skill: "Perception",
              dc: 13,
              reason: "Notice the most relevant hidden detail before the scene advances.",
            },
          ]
        : [],
      choices: [
        "Proceed cautiously",
        "Ask an NPC for more information",
        "Try a creative alternative",
      ],
      stateUpdates: {
        currentScene: campaign.currentScene || "The opening scene is now in motion.",
        addWorldFacts: [],
        addOpenThreads: ["Determine what is concealed in the current scene."],
        resolveOpenThreads: [],
        addNotes: [`${request.actor}: ${request.message}`],
      },
      safety: { status: "ok", reason: "" },
    };
  }
}
