import type { Transcriber, TranscriptionResult } from ".";
import { LocalWhisperService } from "../localWhisperService";

/**
 * Runs whisper.cpp inside the app process. No Python, no separate server, and no
 * model in memory unless local transcription is switched on.
 */
export class WhisperCppTranscriber implements Transcriber {
  constructor(private readonly local: LocalWhisperService) {}

  async transcribe(filePath: string): Promise<TranscriptionResult> {
    throw new Error(
      "Local transcription needs decoded audio. Record a new clip instead of " +
        `transcribing an existing file (${filePath}).`
    );
  }

  async transcribePcm(pcm: Float32Array): Promise<TranscriptionResult> {
    const text = await this.local.transcribe(pcm);
    return { text, cost: 0 };
  }
}
