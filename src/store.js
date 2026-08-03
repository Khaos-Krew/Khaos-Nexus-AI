import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function localWorkspace(campaign) {
  if (!campaign) return null;
  return {
    role: "dm",
    campaign: {
      id: campaign.id,
      tenant_id: campaign.tenantId ?? null,
      name: campaign.name,
      description: campaign.tone,
      status: campaign.status ?? "planning",
      ruleset: campaign.system,
      current_location: campaign.currentScene,
      ai_state: {
        mode: campaign.mode,
        contentRating: campaign.contentRating,
        lore: campaign.lore,
        rulesNotes: campaign.rulesNotes,
        safety: campaign.safety,
        worldFacts: campaign.worldFacts,
        openThreads: campaign.openThreads,
        notes: campaign.notes,
        transcript: campaign.transcript,
      },
      created_at: campaign.createdAt,
      updated_at: campaign.updatedAt,
    },
    members: [],
    characters: campaign.playerCharacters.map((character) => ({
      id: character.id,
      name: character.name,
      player_name: character.playerName,
      summary: character.summary,
    })),
    npcs: [],
    quests: [],
    locations: [],
    factions: [],
    loot: [],
    sessions: [],
    encounters: [],
    homebrew: [],
  };
}

class LocalHomebrewStore {
  constructor() {
    this.homebrew = new Map();
    this.workspaceRecords = new Map();
  }

  createHomebrewRecord(campaignId, result) {
    const id = randomUUID();
    const record = {
      id,
      campaign_id: campaignId,
      content_type: result.contentType,
      name: result.title,
      status: "draft",
      revision: 1,
      body: structuredClone(result),
      approved_by: null,
      approved_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.homebrew.set(id, record);
    return structuredClone(record);
  }

  approveHomebrewRecord(campaignId, homebrewId) {
    const record = this.homebrew.get(homebrewId);
    if (!record || record.campaign_id !== campaignId) return null;
    record.status = "approved";
    record.revision += 1;
    record.approved_at = new Date().toISOString();
    record.updated_at = record.approved_at;
    return structuredClone(record);
  }

  listHomebrew(campaignId) {
    return [...this.homebrew.values()]
      .filter((record) => record.campaign_id === campaignId)
      .map((record) => structuredClone(record));
  }

  workspaceFor(campaignId) {
    if (!this.workspaceRecords.has(campaignId)) {
      this.workspaceRecords.set(campaignId, {
        npcs: [], locations: [], factions: [], quests: [], loot: [], sessions: [], calendarEvents: [],
      });
    }
    return this.workspaceRecords.get(campaignId);
  }

  executeWorkspaceToolRecord(campaignId, tool, args) {
    const workspace = this.workspaceFor(campaignId);
    const now = new Date().toISOString();
    const upsert = (collection, values) => {
      const id = values.id ?? randomUUID();
      const index = collection.findIndex((item) => item.id === id);
      const record = { ...(index >= 0 ? collection[index] : {}), ...structuredClone(values), id, updated_at: now };
      if (index >= 0) collection[index] = record;
      else collection.push({ ...record, created_at: now });
      return structuredClone(record);
    };

    switch (tool) {
      case "upsert_npc":
        return { tool, record: upsert(workspace.npcs, args) };
      case "upsert_location":
        return { tool, record: upsert(workspace.locations, args) };
      case "upsert_faction":
        return { tool, record: upsert(workspace.factions, args) };
      case "upsert_quest":
        return { tool, record: upsert(workspace.quests, args) };
      case "upsert_loot":
        return { tool, record: upsert(workspace.loot, args) };
      case "upsert_session":
        return { tool, record: upsert(workspace.sessions, args) };
      case "approve_session_recap": {
        const session = workspace.sessions.find((item) => item.id === args.sessionId);
        if (!session) return null;
        session.recapApprovedAt = now;
        session.updated_at = now;
        return { tool, record: structuredClone(session) };
      }
      case "upsert_calendar_event":
        return { tool, record: upsert(workspace.calendarEvents, args) };
      default:
        throw new Error(`Unsupported workspace tool: ${tool}`);
    }
  }
}

export class JsonCampaignStore extends LocalHomebrewStore {
  constructor(directory) {
    super();
    this.directory = directory;
    this.name = "json";
    this.requiresAuth = false;
  }

  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true });
  }

  filePath(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid campaign id");
    return path.join(this.directory, `${id}.json`);
  }

  async list() {
    await this.ensureDirectory();
    const files = await readdir(this.directory);
    const campaigns = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => JSON.parse(await readFile(path.join(this.directory, file), "utf8"))),
    );
    return campaigns.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id) {
    await this.ensureDirectory();
    try {
      return JSON.parse(await readFile(this.filePath(id), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(campaign) {
    await this.ensureDirectory();
    const target = this.filePath(campaign.id);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(campaign, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
    return structuredClone(campaign);
  }

  async create(campaign) {
    return this.save(campaign);
  }

  async update(campaign) {
    return this.save(campaign);
  }

  async getWorkspace(id) {
    const workspace = localWorkspace(await this.get(id));
    if (workspace) {
      workspace.homebrew = this.listHomebrew(id);
      Object.assign(workspace, structuredClone(this.workspaceFor(id)));
    }
    return workspace;
  }

  async createHomebrew(campaignId, result) {
    return this.createHomebrewRecord(campaignId, result);
  }

  async approveHomebrew(campaignId, homebrewId) {
    return this.approveHomebrewRecord(campaignId, homebrewId);
  }

  async executeWorkspaceTool(campaignId, tool, args) {
    return this.executeWorkspaceToolRecord(campaignId, tool, args);
  }
}

export class MemoryCampaignStore extends LocalHomebrewStore {
  constructor() {
    super();
    this.campaigns = new Map();
    this.name = "memory";
    this.requiresAuth = false;
  }

  async list() {
    return [...this.campaigns.values()]
      .map((campaign) => structuredClone(campaign))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id) {
    const campaign = this.campaigns.get(id);
    return campaign ? structuredClone(campaign) : null;
  }

  async save(campaign) {
    this.campaigns.set(campaign.id, structuredClone(campaign));
    return structuredClone(campaign);
  }

  async create(campaign) {
    return this.save(campaign);
  }

  async update(campaign) {
    return this.save(campaign);
  }

  async getWorkspace(id) {
    const workspace = localWorkspace(await this.get(id));
    if (workspace) {
      workspace.homebrew = this.listHomebrew(id);
      Object.assign(workspace, structuredClone(this.workspaceFor(id)));
    }
    return workspace;
  }

  async createHomebrew(campaignId, result) {
    return this.createHomebrewRecord(campaignId, result);
  }

  async approveHomebrew(campaignId, homebrewId) {
    return this.approveHomebrewRecord(campaignId, homebrewId);
  }

  async executeWorkspaceTool(campaignId, tool, args) {
    return this.executeWorkspaceToolRecord(campaignId, tool, args);
  }
}
