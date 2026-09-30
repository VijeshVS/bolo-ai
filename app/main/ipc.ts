import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { pasteTextAtCursor } from "./pasteService";
import { checkPermissions } from "./permissionService";
import { HistoryService } from "../services/historyService";
import { LocalWhisperService } from "../services/localWhisperService";
import { PipelineService } from "../services/pipelineService";
import { SnippetService } from "../services/snippetService";
import { SettingsService } from "../services/settingsService";
import { TranscriberFactory } from "../services/transcriber/factory";
import { logger } from "../utils/logger";

// One in-process model, shared by the pipeline and the settings UI.
const localWhisper = new LocalWhisperService();
const settingsService = new SettingsService();

TranscriberFactory.local = localWhisper;

function normalizeAudioBytes(input: unknown): Buffer {
  if (Buffer.isBuffer(input)) {
    return input;
  }

  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }

  if (input instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(input));
  }

  throw new Error("Unsupported audio payload format");
}

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  const seedPath = path.join(app.getAppPath(), "app", "db", "snippets.json");
  const storePath = path.join(app.getPath("userData"), "snippets.json");
  const historyPath = path.join(app.getPath("userData"), "transcription-history.json");

  const snippetService = new SnippetService(storePath, seedPath);
  const historyService = new HistoryService(historyPath);
  const pipelineService = new PipelineService(snippetService, localWhisper);

  ipcMain.handle("permissions:check", async (_event, options?: { requestMicrophone?: boolean; promptAccessibility?: boolean }) => {
    return checkPermissions(options);
  });

  ipcMain.handle(
    "pipeline:process-audio",
    async (_event, payload: { audioData: unknown; mimeType: string; pcm?: ArrayLike<number> }) => {
    const audioBuffer = normalizeAudioBytes(payload.audioData);
    const mimeType = payload.mimeType || "audio/webm";
    // Mono 16 kHz samples, only supplied when local transcription is on.
    const pcm = payload.pcm ? Float32Array.from(payload.pcm) : undefined;

    logger.info("Received audio payload", { bytes: audioBuffer.length, mimeType });

    const result = await pipelineService.processAudio(audioBuffer, mimeType, pcm);
    
    const wordCount = result.transcript.split(/\s+/).filter(w => w.length > 0).length;
    await historyService.addRecord({
      timestamp: Date.now(),
      transcript: result.transcript,
      outputText: result.outputText,
      intent: result.intent,
      wordCount,
      tokenCount: result.tokenCount,
      cost: result.cost
    });
    
    await pasteTextAtCursor(result.outputText);

    return result;
    }
  );

  ipcMain.handle("snippets:get", async () => snippetService.getAll());
  ipcMain.handle("snippets:set", async (_event, payload: { key: string; value: string }) => {
    await snippetService.setSnippet(payload.key, payload.value);
    return snippetService.getAll();
  });
  ipcMain.handle("snippets:remove", async (_event, payload: { key: string }) => {
    await snippetService.removeSnippet(payload.key);
    return snippetService.getAll();
  });

  ipcMain.handle("history:get-analytics", async () => historyService.getAnalytics());
  ipcMain.handle("history:clear", async () => {
    await historyService.clearHistory();
    return { success: true };
  });

  ipcMain.handle("settings:get", async () => {
    await settingsService.init();
    return settingsService.getSettings();
  });

  ipcMain.handle("settings:update", async (_event, settings) => {
    await settingsService.updateSettings(settings);
    await syncLocalWhisperModel();
    return settingsService.getSettings();
  });

  ipcMain.handle("local-whisper:status", async () => localWhisper.getState());

  ipcMain.handle("local-whisper:enable", async () => localWhisper.enable());

  ipcMain.handle("local-whisper:disable", async () => localWhisper.disable());

  ipcMain.handle("window:show", async () => {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isMaximized()) {
      mainWindow.maximize();
    }
    mainWindow.show();
    mainWindow.focus();
  });
}

/**
 * Loads or frees the model to match the saved setting, so the switch is the
 * single source of truth for whether the model is resident in memory. Called on
 * launch and whenever settings are saved.
 */
export async function syncLocalWhisperModel(): Promise<void> {
  await settingsService.init();
  const enabled = settingsService.getSettings().transcriber.localWhisperEnabled === true;

  if (enabled) {
    await localWhisper.ensureLoaded();
    return;
  }

  await localWhisper.disable();
}

export function stopLocalWhisperModel(): void {
  void localWhisper.disable();
}
