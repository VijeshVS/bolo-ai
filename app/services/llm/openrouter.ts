import OpenAI from "openai";
import type { LLMProcessor, IntentDetectionResult, TextFormattingResult, IntentLabel } from "./index";
import { INTENT_LABELS } from "./index";
import { logger } from "../../utils/logger";

const COST_PER_INPUT_TOKEN = 0;
const COST_PER_OUTPUT_TOKEN = 0;

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

export class OpenRouterProcessor implements LLMProcessor {
  private client: OpenAI;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey || process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error("OpenRouter API key is not configured");
    }

    this.client = new OpenAI({
      apiKey: key,
      baseURL: "https://openrouter.ai/api/v1"
    });
    this.model = model || process.env.OPENROUTER_MODEL || "openrouter/free";
  }

  private calculateTokenCost(inputTokens: number, outputTokens: number): number {
    const cost = inputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN;
    return Math.round(cost * 10000) / 10000;
  }

  async detectIntent(rawText: string): Promise<IntentDetectionResult> {
    logger.info("LLM call starting", {
      provider: "openrouter",
      operation: "detect-intent",
      model: this.model
    });

    const completion = await this.client.chat.completions.create({
      model: this.model,
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
    const cost = this.calculateTokenCost(inputTokens, outputTokens);

    if (INTENT_LABELS.includes(label)) {
      return { label, tokenCount, cost };
    }

    return { label: "paragraph", tokenCount, cost };
  }

  async formatStructuredText(rawText: string, intent: IntentLabel): Promise<TextFormattingResult> {
    logger.info("LLM call starting", {
      provider: "openrouter",
      operation: "format-structured-text",
      model: this.model
    });

    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `${STRUCTURING_SYSTEM_PROMPT}\n\nIntent: ${intent}. ${this.intentInstruction(intent)}`
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
    const cost = this.calculateTokenCost(inputTokens, outputTokens);

    return { text, tokenCount, cost };
  }

  private intentInstruction(intent: IntentLabel): string {
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
}