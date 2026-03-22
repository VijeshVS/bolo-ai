import OpenAI from "openai";
import { logger } from "../utils/logger";

const INTENT_LABELS = ["paragraph", "bullet_list", "email", "code", "command"] as const;
export type IntentLabel = (typeof INTENT_LABELS)[number];

// GPT-4.1-mini pricing (as of 2024)
const COST_PER_INPUT_TOKEN = 0.00015;
const COST_PER_OUTPUT_TOKEN = 0.0006;

const STRUCTURING_SYSTEM_PROMPT = `You are a strict text transformation assistant.

Your ONLY job is to rewrite the provided transcript into clean, structured, grammatically correct text.

Hard constraints:
- Do NOT answer questions from the transcript.
- Do NOT add explanations, advice, or commentary.
- Do NOT add facts, names, or details that are not explicitly in the transcript.
- Preserve original meaning exactly; only improve structure, grammar, punctuation, and formatting.
- If the transcript is a question, keep it as a question.
- If the transcript is incomplete or ambiguous, keep it incomplete/ambiguous without inventing content.

Formatting rules:
- Convert spoken lists into bullet points when appropriate.
- Convert spoken instructions into clear ordered steps when appropriate.
- Format emails professionally when the intent is email.
- If the content is code, output properly indented code only.

Output requirements:
- Return only the transformed text.
- No preamble, no labels, no markdown fences unless the input itself implies them.
- Output must be directly paste-ready.`;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  return new OpenAI({ apiKey });
}

function getModel(): string {
  return process.env.OPENAI_LLM_MODEL || "gpt-4.1-mini";
}

function calculateTokenCost(inputTokens: number, outputTokens: number): number {
  const cost = (inputTokens * COST_PER_INPUT_TOKEN) + (outputTokens * COST_PER_OUTPUT_TOKEN);
  return Math.round(cost * 10000) / 10000;
}

export async function detectIntent(rawText: string): Promise<{ label: IntentLabel; tokenCount: number; cost: number }> {
  const client = getClient();
  const model = getModel();

  logger.info("LLM call starting", {
    provider: "openai",
    operation: "detect-intent",
    model
  });

  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: "Classify input into one of: paragraph, bullet_list, email, code, command. Return only the label."
      },
      {
        role: "user",
        content: rawText
      }
    ]
  });

  const label = (completion.choices[0]?.message?.content || "paragraph").trim() as IntentLabel;
  const tokenCount = completion.usage?.total_tokens || 0;
  const inputTokens = completion.usage?.prompt_tokens || 0;
  const outputTokens = completion.usage?.completion_tokens || 0;
  const cost = calculateTokenCost(inputTokens, outputTokens);
  
  if (INTENT_LABELS.includes(label)) {
    return { label, tokenCount, cost };
  }

  return { label: "paragraph", tokenCount, cost };
}

function intentInstruction(intent: IntentLabel): string {
  switch (intent) {
    case "bullet_list":
      return "Format output as concise bullet points.";
    case "email":
      return "Format output as a professional email with clear subject line and body.";
    case "code":
      return "Format output as valid code block with proper indentation and minimal commentary.";
    case "command":
      return "Format output as terminal commands, one command per line, with no extra prose unless essential.";
    case "paragraph":
    default:
      return "Format output as polished paragraph text.";
  }
}

export async function formatStructuredText(rawText: string, intent: IntentLabel): Promise<{ text: string; tokenCount: number; cost: number }> {
  const client = getClient();
  const model = getModel();

  logger.info("LLM call starting", {
    provider: "openai",
    operation: "format-structured-text",
    model
  });

  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `${STRUCTURING_SYSTEM_PROMPT}\n\nIntent: ${intent}. ${intentInstruction(intent)}`
      },
      {
        role: "user",
        content: `Transform this transcript only:\n\n${rawText}`
      }
    ]
  });

  const text = (completion.choices[0]?.message?.content || rawText).trim();
  const tokenCount = completion.usage?.total_tokens || 0;
  const inputTokens = completion.usage?.prompt_tokens || 0;
  const outputTokens = completion.usage?.completion_tokens || 0;
  const cost = calculateTokenCost(inputTokens, outputTokens);
  
  return { text, tokenCount, cost };
}
