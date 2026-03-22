import fs from "node:fs";
import { promises as fsp } from "node:fs";
import type { Transcriber, TranscriptionResult } from "./index";
import { logger } from "../../utils/logger";

type SpeechClient = any;

// Google Speech-to-Text pricing: varies by audio duration
// Standard: $0.024 per 15 seconds of audio (after free tier)
const GOOGLE_COST_PER_15_SECONDS = 0.024;

export class GoogleTranscriber implements Transcriber {
  private projectId: string;
  private credentials: string;
  private model: string;

  constructor(projectId?: string, credentialsPath?: string) {
    this.projectId = projectId || process.env.GOOGLE_PROJECT_ID || "";
    this.credentials = credentialsPath || process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
    this.model = process.env.GOOGLE_SPEECH_MODEL || "default";

    if (!this.projectId) {
      throw new Error("Google Project ID is not configured");
    }

    if (!this.credentials) {
      throw new Error("Google credentials path is not configured");
    }
  }

  async transcribe(filePath: string, _prompt?: string): Promise<TranscriptionResult> {
    // Dynamic import to avoid requiring the package unless used
    let SpeechClient: SpeechClient;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const speechModule = require("@google-cloud/speech");
      SpeechClient = speechModule.SpeechClient;
    } catch (error) {
      throw new Error(
        "Failed to load Google Cloud Speech SDK. Please install @google-cloud/speech: npm install @google-cloud/speech"
      );
    }

    const client = new SpeechClient({
      projectId: this.projectId,
      keyFilename: this.credentials
    });

    const audioBytes = await fsp.readFile(filePath);
    const audioContent = audioBytes.toString("base64");

    const request = {
      audio: {
        content: audioContent
      },
      config: {
        encoding: "WEBM_OPUS" as const,
        sampleRateHertz: 48000,
        languageCode: "en-US",
        ...(this.model !== "default" ? { model: this.model } : {})
      }
    };

    logger.info("Speech-to-text call starting", {
      provider: "google",
      operation: "transcribe-audio",
      model: this.model
    });

    const [response] = await client.recognize(request as never);
    const transcription = response.results
      ?.map((result: { alternatives?: { transcript?: string }[] }) =>
        result.alternatives?.[0]?.transcript || ""
      )
      .join(" ")
      .trim() || "";

    // Estimate cost based on audio file size
    const fileStat = await fsp.stat(filePath);
    const estimatedDurationSeconds = Math.max(15, Math.round(fileStat.size / 64000));
    const fifteenSecondChunks = Math.ceil(estimatedDurationSeconds / 15);
    const cost = Math.round(fifteenSecondChunks * GOOGLE_COST_PER_15_SECONDS * 10000) / 10000;

    return { text: transcription, cost };
  }
}
