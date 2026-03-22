import fs from "node:fs";
import { promises as fsp } from "node:fs";
import OpenAI from "openai";
import type { Transcriber, TranscriptionResult } from "./index";
import { logger } from "../../utils/logger";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const WHISPER_COST_PER_MINUTE = 0.02;

export class OpenAITranscriber implements Transcriber {
  private client: OpenAI;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("OpenAI API key is not configured");
    }

    this.client = new OpenAI({ apiKey: key });
    this.model = model || process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-transcribe";
  }

  async transcribe(filePath: string, prompt?: string): Promise<TranscriptionResult> {
    const fileStat = await fsp.stat(filePath);
    if (fileStat.size > MAX_AUDIO_BYTES) {
      throw new Error("Audio file exceeds 25MB limit");
    }

    logger.info("Speech-to-text call starting", {
      provider: "openai",
      operation: "transcribe-audio",
      model: this.model
    });

    const response = await this.client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: this.model,
      response_format: "text",
      prompt
    });

    let text = "";
    if (typeof response === "string") {
      text = response.trim();
    } else {
      const typedResponse = response as { text?: string };
      text = (typedResponse.text || "").trim();
    }

    // Estimate audio duration from file size: ~64kb per second for webm
    const estimatedDurationSeconds = Math.max(10, Math.round(fileStat.size / 64000));
    const estimatedDurationMinutes = estimatedDurationSeconds / 60;
    const cost = Math.round(estimatedDurationMinutes * WHISPER_COST_PER_MINUTE * 10000) / 10000;

    return { text, cost };
  }
}
