import type { Transcriber, TranscriptionResult } from ".";

interface WhisperResponse {
  status?: string;
  text?: string;
  message?: string;
}

export class WhisperTranscriber implements Transcriber {
  private readonly baseUrl: string;

  constructor(port = 8000) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async transcribe(filePath: string): Promise<TranscriptionResult> {
    let response: Response;

    try {
      response = await fetch(
        `${this.baseUrl}/transcribe?audio_path=${encodeURIComponent(filePath)}`,
        { signal: AbortSignal.timeout(120_000) }
      );
    } catch {
      throw new Error(
        "Could not reach the local transcription server. Check that it is running in Settings."
      );
    }

    const data = (await response.json()) as WhisperResponse;

    if (!response.ok || data.status !== "success") {
      throw new Error(data.message || `Local transcription failed (HTTP ${response.status}).`);
    }

    return { text: data.text ?? "", cost: 0 };
  }
}
