import fs from "node:fs";
import { promises as fsp } from "node:fs";
import OpenAI from "openai";
import { logger } from "../utils/logger";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// OpenAI Whisper pricing: $0.02 per minute (as of 2024)
const WHISPER_COST_PER_MINUTE = 0.02;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  return new OpenAI({ apiKey });
}

export async function transcribeAudio(filePath: string, prompt?: string): Promise<{ text: string; cost: number }> {
  const fileStat = await fsp.stat(filePath);
  if (fileStat.size > MAX_AUDIO_BYTES) {
    throw new Error("Audio file exceeds 25MB limit");
  }

  const client = getClient();
  const model = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-transcribe";

  logger.info("Speech-to-text call starting", {
    provider: "openai",
    operation: "transcribe-audio",
    model
  });

  const response = await client.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model,
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
