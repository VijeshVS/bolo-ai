import type { Transcriber } from "./index";
import { getTranscriberType } from "./index";
import { OpenAITranscriber } from "./openai";
import { GoogleTranscriber } from "./google";
import type { TranscriberConfig } from "../settingsService";
import { WhisperTranscriber } from "./whisper";

export class TranscriberFactory {
  static create(config?: TranscriberConfig): Transcriber {
    const type = config?.type || getTranscriberType();

    switch (type) {
      case "openai":
        if (config?.openai) {
          return new OpenAITranscriber(config.openai.apiKey, config.openai.model);
        }
        return new OpenAITranscriber();
      case "google":
        if (config?.google) {
          return new GoogleTranscriber(config.google.projectId, config.google.credentialsPath);
        }
        return new GoogleTranscriber();
      case "groq":
        // Lazy import avoids editor/module-resolution hiccups when the provider file is added later.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { GroqTranscriber } = require("./groq") as { GroqTranscriber: new (apiKey?: string, model?: string) => Transcriber };
        if (config?.groq) {
          return new GroqTranscriber(config.groq.apiKey, config.groq.model);
        }
        return new GroqTranscriber();
      case "whisper":
        return new WhisperTranscriber();
      default:
        throw new Error(`Unsupported transcriber type: ${type}`);
    }
  }
}
