import type { LLMProcessor, IntentDetectionResult, TextFormattingResult, IntentLabel } from "./index";
import { INTENT_LABELS } from "./index";
import { logger } from "../../utils/logger";

type Anthropic = any;

// Claude 3 pricing (as of 2024) - using Claude 3.5 Sonnet
const COST_PER_INPUT_TOKEN = 0.003 / 1000; // $0.003 per 1k input tokens
const COST_PER_OUTPUT_TOKEN = 0.015 / 1000; // $0.015 per 1k output tokens

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

export class AnthropicProcessor implements LLMProcessor {
  private client: Anthropic;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error("Anthropic API key is not configured");
    }

    // Dynamic import to avoid requiring the package unless used
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const AnthropicModule = require("@anthropic-ai/sdk");
      this.client = new AnthropicModule.default({ apiKey: key });
    } catch (error) {
      throw new Error(
        "Failed to load Anthropic SDK. Please install @anthropic-ai/sdk: npm install @anthropic-ai/sdk"
      );
    }

    this.model = model || process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";
  }

  private calculateTokenCost(inputTokens: number, outputTokens: number): number {
    const cost = inputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN;
    return Math.round(cost * 10000) / 10000;
  }

  async detectIntent(rawText: string): Promise<IntentDetectionResult> {
    logger.info("LLM call starting", {
      provider: "anthropic",
      operation: "detect-intent",
      model: this.model
    });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 100,
      system: "Classify input into one of: paragraph, bullet_list, email, code, command. Return only the label.",
      messages: [
        {
          role: "user",
          content: rawText
        }
      ]
    });

    const label = (response.content[0]?.type === "text" ? response.content[0].text : "paragraph").trim() as IntentLabel;
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const tokenCount = inputTokens + outputTokens;
    const cost = this.calculateTokenCost(inputTokens, outputTokens);

    if (INTENT_LABELS.includes(label)) {
      return { label, tokenCount, cost };
    }

    return { label: "paragraph", tokenCount, cost };
  }

  async formatStructuredText(rawText: string, intent: IntentLabel): Promise<TextFormattingResult> {
    logger.info("LLM call starting", {
      provider: "anthropic",
      operation: "format-structured-text",
      model: this.model
    });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: `${STRUCTURING_SYSTEM_PROMPT}\n\nIntent: ${intent}. ${this.intentInstruction(intent)}`,
      messages: [
        {
          role: "user",
          content: `Transform this transcript only:\n\n${rawText}`
        }
      ]
    });

    const text = (response.content[0]?.type === "text" ? response.content[0].text : rawText).trim();
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const tokenCount = inputTokens + outputTokens;
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
