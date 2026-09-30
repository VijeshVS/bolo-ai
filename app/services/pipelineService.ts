import { removeTempAudioFile, saveAudioBufferToTempFile } from "./audioService";
import { SnippetService } from "./snippetService";
import { TranscriberFactory } from "./transcriber/factory";
import { LLMFactory } from "./llm/factory";
import { SettingsService } from "./settingsService";
import { LocalWhisperService } from "./localWhisperService";
import type { IntentLabel } from "./llm/index";

export interface PipelineResult {
  transcript: string;
  expandedText: string;
  intent: IntentLabel;
  outputText: string;
  tokenCount: number;
  cost: number;
}

export class PipelineService {
  private settingsService: SettingsService;

  constructor(
    private readonly snippetService: SnippetService,
    private readonly localWhisper: LocalWhisperService
  ) {
    this.settingsService = new SettingsService();
  }

  async processAudio(audioBuffer: Buffer, mimeType: string): Promise<PipelineResult> {
    const audioFilePath = await saveAudioBufferToTempFile(audioBuffer, mimeType);

    await this.settingsService.init();
    const settings = this.settingsService.getSettings();

    if (settings.transcriber.localServerEnabled) {
      const ready = await this.localWhisper.ensureRunning();

      if (!ready) {
        const state = this.localWhisper.getState();
        await removeTempAudioFile(audioFilePath);
        throw new Error(
          state.message || "The local transcription server is not running. Check Settings."
        );
      }
    }

    const transcriber = TranscriberFactory.create(settings.transcriber);

    try {
      const transcriptionResult = await transcriber.transcribe(audioFilePath);
      const transcript = transcriptionResult.text;
      let totalCost = transcriptionResult.cost;

      const expandedText = await this.snippetService.expand(transcript);

      let intent: IntentLabel = "paragraph";
      let outputText = expandedText;
      let tokenCount = 0;

      // With correction off the snippet-expanded transcript is pasted as
      // recognised. The processor is not even constructed, so this mode needs
      // no LLM credentials at all.
      if (settings.llm.correctionEnabled !== false) {
        const llmProcessor = LLMFactory.create(settings.llm);

        try {
          const intentResult = await llmProcessor.detectIntent(expandedText);
          intent = intentResult.label;
          tokenCount += intentResult.tokenCount;
          totalCost += intentResult.cost;

          const formatResult = await llmProcessor.formatStructuredText(expandedText, intent);
          outputText = formatResult.text;
          tokenCount += formatResult.tokenCount;
          totalCost += formatResult.cost;
        } catch {
          // Fallback to expanded transcript when AI formatting fails.
        }
      }

      return {
        transcript,
        expandedText,
        intent,
        outputText: outputText || expandedText,
        tokenCount,
        cost: Math.round(totalCost * 10000) / 10000
      };
    } finally {
      await removeTempAudioFile(audioFilePath);
    }
  }
}
