import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class JsonCampaignStore {
  constructor(directory) {
    this.directory = directory;
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
  }
}

export class MemoryCampaignStore {
  constructor() {
    this.campaigns = new Map();
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
  }
}
