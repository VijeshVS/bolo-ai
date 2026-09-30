import { readFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../utils/logger";

/**
 * Minimal client for the OpenAI-compatible REST API. The providers in use
 * (OpenAI, Groq, OpenRouter) all speak the same `/chat/completions` and
 * `/audio/transcriptions` shape, so the official SDK is not needed.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenAICompatibleClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly providerLabel: string
  ) {}

  private url(pathname: string): string {
    return `${this.baseURL.replace(/\/+$/, "")}${pathname}`;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.headers as Record<string, string> | undefined)
      }
    });

    if (!response.ok) {
      throw new Error(await this.describeFailure(response));
    }

    return response;
  }

  /**
   * Providers report failures as `{ error: { message } }` but not always, so
   * fall back to the raw body rather than surfacing "Unexpected token <".
   */
  private async describeFailure(response: Response): Promise<string> {
    const body = await response.text().catch(() => "");
    let detail = body;

    try {
      const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message || parsed.message || body;
    } catch {
      // Not JSON; the raw body is the best available detail.
    }

    const suffix = detail ? `: ${detail}` : "";
    return `${this.providerLabel} request failed (${response.status} ${response.statusText})${suffix}`;
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    temperature: number
  ): Promise<ChatResult> {
    const response = await this.send(this.url("/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature, messages })
    });

    const payload = (await response.json()) as ChatCompletionResponse;
    const usage = payload.usage || {};

    return {
      text: payload.choices?.[0]?.message?.content || "",
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0
    };
  }

  /**
   * `response_format: "text"` makes the endpoint answer with a bare string, so
   * the body is read as text rather than parsed.
   */
  async transcribe(
    model: string,
    filePath: string,
    prompt?: string,
    temperature?: number
  ): Promise<string> {
    const form = new FormData();
    const audio = await readFile(filePath);

    form.append(
      "file",
      new Blob([new Uint8Array(audio)], { type: "application/octet-stream" }),
      path.basename(filePath)
    );
    form.append("model", model);
    form.append("response_format", "text");
    if (prompt) {
      form.append("prompt", prompt);
    }
    if (temperature !== undefined) {
      form.append("temperature", String(temperature));
    }

    logger.info("Uploading audio for transcription", {
      provider: this.providerLabel,
      model,
      bytes: audio.byteLength
    });

    const response = await this.send(this.url("/audio/transcriptions"), {
      method: "POST",
      body: form
    });

    return (await response.text()).trim();
  }
}
