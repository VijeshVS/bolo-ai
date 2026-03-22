export interface TranscriptionResult {
  text: string;
  cost: number;
  tokenCount?: number;
}

export interface Transcriber {
  transcribe(filePath: string, prompt?: string): Promise<TranscriptionResult>;
}

export type TranscriberType = "openai" | "google" | "groq";

export function getTranscriberType(): TranscriberType {
  const type = process.env.TRANSCRIBER_TYPE || "openai";
  if (!["openai", "google", "groq"].includes(type)) {
    throw new Error(`Unknown transcriber type: ${type}`);
  }
  return type as TranscriberType;
}
