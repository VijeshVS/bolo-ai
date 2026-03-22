export interface IntentDetectionResult {
  label: IntentLabel;
  tokenCount: number;
  cost: number;
}

export interface TextFormattingResult {
  text: string;
  tokenCount: number;
  cost: number;
}

export const INTENT_LABELS = ["paragraph", "bullet_list", "email", "code", "command"] as const;
export type IntentLabel = (typeof INTENT_LABELS)[number];

export interface LLMProcessor {
  detectIntent(rawText: string): Promise<IntentDetectionResult>;
  formatStructuredText(rawText: string, intent: IntentLabel): Promise<TextFormattingResult>;
}

export type LLMType = "openai" | "anthropic" | "google" | "xai" | "groq" | "openrouter";

export function getLLMType(): LLMType {
  const type = process.env.LLM_TYPE || "openai";
  if (!["openai", "anthropic", "google", "xai", "groq", "openrouter"].includes(type)) {
    throw new Error(`Unknown LLM type: ${type}`);
  }
  return type as LLMType;
}
