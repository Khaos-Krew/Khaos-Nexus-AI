import { turnResultJsonSchema, validateTurnResult } from "./domain.js";
import { generateProceduralMap, mapResultJsonSchema, validateMapResult } from "./maps.js";

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

function buildMapInstructions(request) {
  return [
    "You are Khaos Nexus AI's original tabletop map planner.",
    `Create a new ${request.mapType} layout using seed ${request.seed}.`,
    `The grid must be exactly ${request.width} by ${request.height}, use ${request.gridType} cells, and use the scale '${request.scale}'.`,
    "Every zone and point coordinate must be an integer inside the grid. Every zone rectangle must fit fully inside the grid.",
    "Every connection, encounter, and hazard must reference a zone id that exists in the zones array.",
    "Create useful tactical choices, alternate routes, readable landmarks, and GM-facing secrets without deciding player actions.",
    "Do not copy, trace, or reconstruct a published map, adventure layout, distinctive location arrangement, or commercial cartography style.",
    "If the request still appears unusually close to a named published map, make a generic original alternative and set originality.status to needs-review.",
    "Return structured map data only. An SVG preview is rendered locally after validation.",
  ].join("\n");
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
      if (content?.type === "refusal" && typeof content.refusal === "string") {
        throw new Error(`OpenAI refused the request: ${content.refusal}`);
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

  async requestStructured({ instructions, input, name, description, schema }) {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        store: false,
        instructions,
        input: JSON.stringify(input),
        text: {
          format: {
            type: "json_schema",
            name,
            description,
            strict: true,
            schema,
          },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      throw new Error(`OpenAI request failed (${response.status}): ${detail}`);
    }
    return JSON.parse(extractOutputText(await response.json()));
  }

  async generateTurn(campaign, request) {
    const output = await this.requestStructured({
      instructions: buildInstructions(campaign),
      input: buildInput(campaign, request),
      name: "dnd_turn",
      description: "A structured D&D Game Master or Co-DM turn.",
      schema: turnResultJsonSchema,
    });
    return validateTurnResult(output);
  }

  async generateMap(request) {
    const output = await this.requestStructured({
      instructions: buildMapInstructions(request),
      input: {
        request: {
          mapType: request.mapType,
          prompt: request.prompt,
          seed: request.seed,
          width: request.width,
          height: request.height,
          gridType: request.gridType,
          scale: request.scale,
          density: request.density,
          biomes: request.biomes,
          features: request.features,
          constraints: request.constraints,
        },
      },
      name: "dnd_map",
      description: "An original tabletop map layout with validated coordinates and GM content.",
      schema: mapResultJsonSchema,
    });
    return validateMapResult(output);
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

  async generateMap(request) {
    return generateProceduralMap(request);
  }
}
