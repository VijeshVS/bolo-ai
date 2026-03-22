import fs from "node:fs";
import { promises as fsp } from "node:fs";
import OpenAI from "openai";
import type { Transcriber, TranscriptionResult } from "./index";
import { logger } from "../../utils/logger";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TURBO_COST_PER_HOUR = 0.04;
const LARGE_V3_COST_PER_HOUR = 0.111;

export class GroqTranscriber implements Transcriber {
  private client: OpenAI;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey || process.env.GROQ_API_KEY;
    if (!key) {
      throw new Error("Groq API key is not configured");
    }

    this.client = new OpenAI({
      apiKey: key,
      baseURL: "https://api.groq.com/openai/v1"
    });
    this.model = model || process.env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo";
  }

  private estimateCost(estimatedDurationSeconds: number): number {
    const hours = estimatedDurationSeconds / 3600;
    const ratePerHour = this.model === "whisper-large-v3" ? LARGE_V3_COST_PER_HOUR : TURBO_COST_PER_HOUR;
    return Math.round(hours * ratePerHour * 10000) / 10000;
  }

  async transcribe(filePath: string, prompt?: string): Promise<TranscriptionResult> {
    const fileStat = await fsp.stat(filePath);
    if (fileStat.size > MAX_AUDIO_BYTES) {
      throw new Error("Audio file exceeds 25MB limit");
    }

    logger.info("Speech-to-text call starting", {
      provider: "groq",
      operation: "transcribe-audio",
      model: this.model
    });

    const response = await this.client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: this.model,
      response_format: "text",
      prompt,
      temperature: 0
    });

    let text = "";
    if (typeof response === "string") {
      text = response.trim();
    } else {
      const typedResponse = response as { text?: string };
      text = (typedResponse.text || "").trim();
    }

    const estimatedDurationSeconds = Math.max(10, Math.round(fileStat.size / 64000));
    const cost = this.estimateCost(estimatedDurationSeconds);

    return { text, cost };
  }
}