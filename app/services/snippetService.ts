import { promises as fs } from "node:fs";
import path from "node:path";

export type SnippetMap = Record<string, string>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class SnippetService {
  private initialized = false;
  private snippets: SnippetMap = {};

  constructor(
    private readonly storePath: string,
    private readonly seedPath?: string
  ) {}

  private async readJson(filePath: string): Promise<SnippetMap> {
    const data = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(data) as unknown;

    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const output: SnippetMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        output[key] = value;
      }
    }

    return output;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(path.dirname(this.storePath), { recursive: true });

    try {
      this.snippets = await this.readJson(this.storePath);
    } catch {
      if (this.seedPath) {
        try {
          this.snippets = await this.readJson(this.seedPath);
        } catch {
          this.snippets = {};
        }
      }
      await this.persist();
    }

    this.initialized = true;
  }

  private async persist(): Promise<void> {
    const tempPath = `${this.storePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.snippets, null, 2), "utf8");
    await fs.rename(tempPath, this.storePath);
  }

  async getAll(): Promise<SnippetMap> {
    await this.init();
    return { ...this.snippets };
  }

  async setSnippet(key: string, value: string): Promise<void> {
    await this.init();
    this.snippets[key.trim().toLowerCase()] = value;
    await this.persist();
  }

  async removeSnippet(key: string): Promise<void> {
    await this.init();
    delete this.snippets[key.trim().toLowerCase()];
    await this.persist();
  }

  async expand(input: string): Promise<string> {
    await this.init();

    let output = input;
    const entries = Object.entries(this.snippets).sort((a, b) => b[0].length - a[0].length);

    for (const [trigger, replacement] of entries) {
      const pattern = new RegExp(`\\b${escapeRegExp(trigger)}\\b`, "gi");
      output = output.replace(pattern, replacement);
    }

    return output;
  }
}
