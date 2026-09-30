import type { LLMProcessor, LLMType } from "./index";
import { getLLMType } from "./index";
import { OpenAIProcessor } from "./openai";
import { GroqProcessor } from "./groq";
import { OpenRouterProcessor } from "./openrouter";
import type { LLMConfig } from "../settingsService";

export class LLMFactory {
  static create(config?: LLMConfig): LLMProcessor {
    const type = config?.type || getLLMType();

    switch (type) {
      case "openai":
        if (config?.openai) {
          return new OpenAIProcessor(config.openai.apiKey, config.openai.model);
        }
        return new OpenAIProcessor();
      case "groq":
        if (config?.groq) {
          return new GroqProcessor(config.groq.apiKey, config.groq.model);
        }
        return new GroqProcessor();
      case "openrouter":
        if (config?.openrouter) {
          return new OpenRouterProcessor(config.openrouter.apiKey, config.openrouter.model);
        }
        return new OpenRouterProcessor();
      default:
        throw new Error(`Unsupported LLM type: ${type}`);
    }
  }
}
