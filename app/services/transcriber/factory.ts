import type { Transcriber } from "./index";
import { getTranscriberType } from "./index";
import { OpenAITranscriber } from "./openai";
import { GoogleTranscriber } from "./google";
import type { TranscriberConfig } from "../settingsService";
import { WhisperCppTranscriber } from "./whisper";
import type { LocalWhisperService } from "../localWhisperService";

export class TranscriberFactory {
  /** The in-process local transcriber needs the owner of the loaded model. */
  static local: LocalWhisperService | null = null;

  static create(config?: TranscriberConfig): Transcriber {
    // Local transcription takes over completely: the selected external provider
    // and its credentials are ignored while it is enabled.
    if (config?.localWhisperEnabled) {
      if (!TranscriberFactory.local) {
        throw new Error("Local transcription is enabled but the model service is unavailable.");
      }
      return new WhisperCppTranscriber(TranscriberFactory.local);
    }

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
        // Only reachable when local transcription is off; whisper.cpp needs the
        // in-process service, so point at the setting rather than silently
        // falling back to a hosted provider.
        throw new Error(
          "Whisper is available as the in-app local transcriber. Enable it under Transcription."
        );
      default:
        throw new Error(`Unsupported transcriber type: ${type}`);
    }
  }
}
