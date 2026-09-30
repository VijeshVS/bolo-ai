export interface TranscriptionResult {
  text: string;
  cost: number;
  tokenCount?: number;
}

export interface Transcriber {
  transcribe(filePath: string, prompt?: string): Promise<TranscriptionResult>;
  /**
   * Mono 16 kHz PCM. Only the in-process whisper.cpp transcriber needs this;
   * every other transcriber reads `filePath` and ignores it.
   */
  transcribePcm?(pcm: Float32Array): Promise<TranscriptionResult>;
}

export type TranscriberType = "openai" | "groq" | "whisper";

const TRANSCRIBER_TYPES: TranscriberType[] = ["openai", "groq", "whisper"];

export function getTranscriberType(): TranscriberType {
  const type = process.env.TRANSCRIBER_TYPE || "openai";
  if (!TRANSCRIBER_TYPES.includes(type as TranscriberType)) {
    throw new Error(`Unknown transcriber type: ${type}`);
  }
  return type as TranscriberType;
}
