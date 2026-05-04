import { app } from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";

export interface TranscriberConfig {
  type: "openai" | "google" | "groq" | "whisper";
  openai?: {
    apiKey: string;
    model: string;
  };
  google?: {
    projectId: string;
    credentialsPath: string;
  };
  groq?: {
    apiKey: string;
    model: string;
  };
  whisper?: {
    
  };
}

export interface LLMConfig {
  type: "openai" | "anthropic" | "google" | "xai" | "groq" | "openrouter";
  openai?: {
    apiKey: string;
    model: string;
  };
  anthropic?: {
    apiKey: string;
    model: string;
  };
  google?: {
    apiKey: string;
    model: string;
  };
  xai?: {
    apiKey: string;
    model: string;
  };
  groq?: {
    apiKey: string;
    model: string;
  };
  openrouter?: {
    apiKey: string;
    model: string;
  };
}

export interface AppSettings {
  transcriber: TranscriberConfig;
  llm: LLMConfig;
}

const DEFAULT_SETTINGS: AppSettings = {
  transcriber: {
    type: "openai",
    openai: {
      apiKey: "",
      model: "gpt-4o-transcribe"
    }
  },
  llm: {
    type: "openai",
    openai: {
      apiKey: "",
      model: "gpt-4.1-mini"
    }
  }
};

export class SettingsService {
  private settingsPath: string;
  private settings: AppSettings = DEFAULT_SETTINGS;

  constructor() {
    this.settingsPath = path.join(app.getPath("userData"), "settings.json");
  }

  async init(): Promise<void> {
    try {
      const data = await fs.readFile(this.settingsPath, "utf8");
      this.settings = JSON.parse(data) as AppSettings;
    } catch {
      // Settings file doesn't exist yet, use defaults
      this.settings = { ...DEFAULT_SETTINGS };
      await this.save();
    }
  }

  private async save(): Promise<void> {
    const tempPath = `${this.settingsPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.settings, null, 2), "utf8");
    await fs.rename(tempPath, this.settingsPath);
  }

  getSettings(): AppSettings {
    return JSON.parse(JSON.stringify(this.settings));
  }

  async updateTranscriberConfig(config: TranscriberConfig): Promise<void> {
    this.settings.transcriber = config;
    await this.save();
  }

  async updateLLMConfig(config: LLMConfig): Promise<void> {
    this.settings.llm = config;
    await this.save();
  }

  async updateSettings(settings: AppSettings): Promise<void> {
    this.settings = settings;
    await this.save();
  }

  getTranscriberConfig(): TranscriberConfig {
    return JSON.parse(JSON.stringify(this.settings.transcriber));
  }

  getLLMConfig(): LLMConfig {
    return JSON.parse(JSON.stringify(this.settings.llm));
  }
}
