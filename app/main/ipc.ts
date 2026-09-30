import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { pasteTextAtCursor } from "./pasteService";
import { checkPermissions } from "./permissionService";
import { HistoryService } from "../services/historyService";
import { LocalWhisperService } from "../services/localWhisperService";
import { PipelineService } from "../services/pipelineService";
import { SnippetService } from "../services/snippetService";
import { SettingsService } from "../services/settingsService";
import { logger } from "../utils/logger";

// One server process per app, shared by the pipeline and the settings UI.
const localWhisper = new LocalWhisperService();
const settingsService = new SettingsService();

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

  ipcMain.handle("pipeline:process-audio", async (_event, payload: { audioData: unknown; mimeType: string }) => {
    const audioBuffer = normalizeAudioBytes(payload.audioData);
    const mimeType = payload.mimeType || "audio/webm";

    logger.info("Received audio payload", { bytes: audioBuffer.length, mimeType });

    const result = await pipelineService.processAudio(audioBuffer, mimeType);
    
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
  });

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
    await syncLocalWhisperServer();
    return settingsService.getSettings();
  });

  ipcMain.handle("local-whisper:status", async () => localWhisper.getState());

  ipcMain.handle("local-whisper:start", async () => {
    await localWhisper.start();
    return localWhisper.getState();
  });

  ipcMain.handle("local-whisper:stop", async () => {
    localWhisper.stop();
    return localWhisper.getState();
  });

  ipcMain.handle("local-whisper:install", async () => {
    const result = await localWhisper.installDependencies();

    if (result.ok) {
      // Installing is pointless unless the server can then actually run.
      await localWhisper.start();
    }

    return { ...result, state: localWhisper.getState() };
  });

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
 * Starts or stops the local server to match the saved setting. Called on launch
 * and whenever settings are saved, so the checkbox is the single source of
 * truth for whether the server runs.
 */
export async function syncLocalWhisperServer(): Promise<void> {
  await settingsService.init();
  const enabled = settingsService.getSettings().transcriber.localServerEnabled === true;

  if (enabled) {
    await localWhisper.ensureRunning();
    return;
  }

  localWhisper.stop();
}

export function stopLocalWhisperServer(): void {
  localWhisper.stop();
}
