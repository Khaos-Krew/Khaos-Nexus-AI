import {
  sessionIntelligenceResultJsonSchema,
  validateSessionIntelligenceResult,
} from "./session-intelligence.js";

function instructions() {
  return [
    "You are Khaos Nexus AI's session analyst and preparation assistant.",
    "Summarize only the supplied campaign workspace, session, notes, and transcript.",
    "Keep the GM recap comprehensive, including secrets and unresolved risks.",
    "Keep the player recap free of hidden entities, GM notes, future plans, unrevealed clues, and private contradictions.",
    "Treat every canon fact and entity change as a proposal requiring manager review; never claim database state was changed.",
    "Mark each canon fact and unresolved thread public only when the supplied information is already player-visible.",
    "Identify contradictions against established campaign facts and entity records without silently resolving them.",
    "Entity changes may reference an existing allow-listed workspace tool, but execution happens separately after manager approval.",
    "Preserve player agency and do not invent player choices, dialogue, rolls, or outcomes not supported by the source material.",
    "Do not quote or reconstruct non-provided copyrighted rulebook or adventure text.",
  ].join("\n");
}

function providerInput(context, request) {
  const campaign = context.campaign;
  const workspace = context.workspace ?? {};
  const session = context.session ?? {};
  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      system: campaign.system,
      tone: campaign.tone,
      currentScene: campaign.currentScene,
      worldFacts: campaign.worldFacts.slice(-100),
      openThreads: campaign.openThreads.slice(-100),
      notes: campaign.notes.slice(-100),
      playerCharacters: campaign.playerCharacters,
    },
    session: {
      id: session.id,
      title: session.title,
      status: session.status,
      startsAt: session.starts_at ?? session.startsAt ?? null,
      endsAt: session.ends_at ?? session.endsAt ?? null,
      agenda: session.agenda ?? "",
      dmNotes: session.dm_notes ?? session.dmNotes ?? "",
      existingRecap: session.recap_draft ?? session.recapDraft ?? "",
    },
    workspace: {
      characters: workspace.characters ?? [],
      npcs: workspace.npcs ?? [],
      locations: workspace.locations ?? [],
      factions: workspace.factions ?? [],
      quests: workspace.quests ?? [],
      loot: workspace.loot ?? [],
      encounters: workspace.encounters ?? [],
    },
    source: request,
    policy: {
      automaticMutation: false,
      managerReviewRequired: true,
      playerOutputMustExcludePrivateContent: true,
    },
  };
}

function compactLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function publicLine(line) {
  return !/^(?:secret(?:\s+fact)?|gm(?:\s+note)?)\s*:/i.test(line);
}

function afterMarker(line) {
  return line.replace(/^[a-z _-]+:\s*/i, "").trim();
}

function openAiSessionSchema() {
  const schema = structuredClone(sessionIntelligenceResultJsonSchema);
  schema.properties.entityChanges.items.properties.arguments = {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
  return schema;
}

export function generateMockSessionIntelligence(context, request) {
  const lines = compactLines(request.sourceNotes);
  const transcriptLines = request.transcript.map((entry) => `${entry.speaker}: ${entry.text}`);
  const publicTranscriptLines = request.transcript
    .filter((entry) => entry.public)
    .map((entry) => `${entry.speaker}: ${entry.text}`);
  const summaryLines = [...lines.filter(publicLine), ...publicTranscriptLines].slice(0, 8);
  const gmLines = [...lines, ...transcriptLines].slice(0, 16);
  const sessionTitle = context.session?.title || `Session intelligence for ${context.campaign.name}`;

  const canonFacts = lines
    .filter((line) => /^(fact|public fact|secret fact)\s*:/i.test(line))
    .map((line) => ({
      statement: afterMarker(line),
      confidence: /^secret fact\s*:/i.test(line) ? "medium" : "high",
      evidence: `Session source note: ${afterMarker(line)}`,
      public: /^public fact\s*:/i.test(line) || /^fact\s*:/i.test(line),
    }));

  const contradictions = lines
    .filter((line) => /^contradiction\s*:/i.test(line))
    .map((line) => {
      const [claim, conflictsWith = "Existing campaign state"] = afterMarker(line).split("||").map((item) => item.trim());
      return {
        claim,
        conflictsWith,
        severity: "warning",
        recommendation: "Have the campaign manager choose the canonical version before applying any state change.",
      };
    });

  const unresolvedThreads = lines
    .filter((line) => /^(thread|public thread|resolved thread)\s*:/i.test(line))
    .map((line) => ({
      thread: afterMarker(line),
      status: /^resolved thread\s*:/i.test(line) ? "resolved" : "open",
      public: /^public thread\s*:/i.test(line) || /^resolved thread\s*:/i.test(line),
      notes: "Extracted from the supplied session notes for manager review.",
    }));

  const entityTypeFor = (line) => {
    if (/^npc\s*:/i.test(line)) return "npc";
    if (/^location\s*:/i.test(line)) return "location";
    if (/^faction\s*:/i.test(line)) return "faction";
    if (/^quest\s*:/i.test(line)) return "quest";
    if (/^loot\s*:/i.test(line)) return "loot";
    return "campaign";
  };
  const toolFor = {
    npc: "upsert_npc",
    location: "upsert_location",
    faction: "upsert_faction",
    quest: "upsert_quest",
    loot: "upsert_loot",
    campaign: "",
  };
  const entityChanges = lines
    .filter((line) => /^(npc|location|faction|quest|loot|campaign)\s*:/i.test(line))
    .map((line) => {
      const entityType = entityTypeFor(line);
      return {
        entityType,
        entityId: "",
        action: "update",
        summary: afterMarker(line),
        proposedTool: toolFor[entityType],
        arguments: {},
        public: publicLine(line),
      };
    });

  const playerRecap = summaryLines.length
    ? summaryLines.join(" ").slice(0, 8_000)
    : `${sessionTitle} concluded with the party's choices and immediate consequences recorded for the next session.`;
  const gmRecap = gmLines.length
    ? gmLines.join("\n").slice(0, 12_000)
    : `${sessionTitle} was analyzed. Review the proposed facts, threads, and preparation before applying campaign changes.`;

  return validateSessionIntelligenceResult({
    version: 1,
    sessionTitle,
    gmRecap,
    playerRecap,
    canonFacts,
    contradictions,
    unresolvedThreads,
    entityChanges,
    nextSessionPrep: request.includePrep
      ? {
          openingScene: unresolvedThreads[0]?.thread
            ? `Open with the consequences of: ${unresolvedThreads[0].thread}`
            : `Open by reconnecting the party to ${context.campaign.currentScene || "the current situation"}.`,
          likelyNpcs: (context.workspace?.npcs ?? []).slice(0, 5).map((npc) => npc.name),
          encounterIdeas: ["Use one unresolved thread as a choice-driven complication rather than a forced outcome."],
          clues: canonFacts.filter((fact) => fact.public).slice(0, 5).map((fact) => fact.statement),
          risks: contradictions.length ? ["Resolve detected continuity conflicts before revealing new canon."] : [],
          questions: ["Which proposed canon facts should become authoritative?", "Which unresolved thread should receive focus next?"],
        }
      : {
          openingScene: "",
          likelyNpcs: [],
          encounterIdeas: [],
          clues: [],
          risks: [],
          questions: [],
        },
  });
}

export function withSessionIntelligence(provider) {
  if (!provider || typeof provider !== "object") throw new Error("AI provider is required");
  if (typeof provider.generateSessionIntelligence === "function") return provider;

  if (provider.name === "openai" && typeof provider.requestStructured === "function") {
    provider.generateSessionIntelligence = async (context, request) => {
      const output = await provider.requestStructured({
        instructions: instructions(),
        input: providerInput(context, request),
        name: "dnd_session_intelligence",
        description: "Manager-reviewed D&D session recap, canon proposals, continuity checks, and next-session preparation.",
        schema: openAiSessionSchema(),
      });
      return validateSessionIntelligenceResult(output);
    };
    return provider;
  }

  if (provider.name === "mock") {
    provider.generateSessionIntelligence = async (context, request) =>
      generateMockSessionIntelligence(context, request);
    return provider;
  }

  throw new Error(`Provider ${provider.name ?? "unknown"} does not support session intelligence`);
}
