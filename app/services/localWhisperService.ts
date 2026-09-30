import { existsSync, mkdirSync, statSync, createWriteStream, renameSync, unlinkSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import path from "node:path";
import { app } from "electron";
import { logger } from "../utils/logger";

// whisper-tiny is the fastest ggml model and, per the request, the one that gets
// loaded into memory when local transcription is switched on.
const MODEL_NAME = "tiny";
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin";
const MODEL_FILE = "ggml-tiny.bin";

export type LocalWhisperStatus = "off" | "downloading" | "loading" | "ready" | "error";

export interface LocalWhisperState {
  status: LocalWhisperStatus;
  message: string;
  /** True while the model is resident in memory. */
  loaded: boolean;
  model: string;
  downloadProgress: number;
  /** Resident memory of the app process, so the cost of the model is visible. */
  memoryMb: number;
}

// Imported lazily: the native module is only needed when the feature is on, so
// a broken or missing binary cannot stop the app from launching.
type WhisperInstance = {
  load(): Promise<unknown>;
  transcribe(
    pcm: Float32Array,
    params: Record<string, unknown>
  ): Promise<{ result: Promise<Array<{ text: string }>> }>;
  free(): Promise<void>;
};

let whisper: WhisperInstance | null = null;
let state: LocalWhisperState = {
  status: "off",
  message: "",
  loaded: false,
  model: MODEL_NAME,
  downloadProgress: 0,
  memoryMb: 0
};
let loadPromise: Promise<boolean> | null = null;

function setState(patch: Partial<LocalWhisperState>): void {
  state = { ...state, ...patch };
  logger.info("Local whisper state", { ...state });
}

function modelsDir(): string {
  return path.join(app.getPath("userData"), "models");
}

function modelPath(): string {
  return path.join(modelsDir(), MODEL_FILE);
}

function isModelDownloaded(): boolean {
  // A truncated download would load as a corrupt model, so require a plausible size.
  try {
    return existsSync(modelPath()) && statSync(modelPath()).size > 50 * 1024 * 1024;
  } catch {
    return false;
  }
}

async function ensureModel(): Promise<string> {
  if (isModelDownloaded()) {
    return modelPath();
  }

  setState({ status: "downloading", message: "Downloading the Whisper model…", downloadProgress: 0 });

  mkdirSync(modelsDir(), { recursive: true });

  const response = await fetch(MODEL_URL);

  if (!response.ok || !response.body) {
    throw new Error(`Model download failed (HTTP ${response.status}).`);
  }

  const total = Number(response.headers.get("content-length") || 0);
  let received = 0;
  let lastReported = -1;

  // Counted with a pass-through transform rather than a "data" listener, which
  // would put the stream into flowing mode and race the pipeline.
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      const percent = total ? Math.floor((received / total) * 100) : 0;

      if (percent !== lastReported) {
        lastReported = percent;
        state = { ...state, downloadProgress: percent };
      }

      callback(null, chunk);
    }
  });

  // Streamed to disk so a 74 MB model is never held in memory.
  await streamPipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    counter,
    createWriteStream(`${modelPath()}.part`)
  );

  if (!isModelDownloaded()) {
    const partPath = `${modelPath()}.part`;
    if (existsSync(partPath)) {
      unlinkSync(partPath);
    }
    throw new Error("The model download was incomplete. Check your connection and try again.");
  }

  // Replace the finished file only once it is known to be complete.
  renameSync(`${modelPath()}.part`, modelPath());

  return modelPath();
}

function createWhisper(file: string): WhisperInstance {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Whisper } = require("smart-whisper") as { Whisper: new (f: string, c: Record<string, unknown>) => WhisperInstance };

  // offload: 0 disables the library's idle timer so the model stays resident
  // exactly as long as the setting is on, and is freed only when it is turned off.
  return new Whisper(file, { gpu: false, offload: 0 });
}

export class LocalWhisperService {
  getState(): LocalWhisperState {
    return { ...state, memoryMb: this.currentMemoryMb() };
  }

  /**
   * Footprint of the main process in MB, as macOS reports it. process.memoryUsage()
   * only covers the JS heap and misses the native allocations whisper.cpp makes,
   * so it cannot answer whether the model is still resident.
   */
  private currentMemoryMb(): number {
    try {
      const metrics = app.getAppMetrics();
      const self = metrics.find((metric) => metric.pid === process.pid);
      return Math.round((self?.memory.workingSetSize ?? 0) / 1024);
    } catch {
      return 0;
    }
  }

  isLoaded(): boolean {
    return state.loaded;
  }

  async enable(): Promise<LocalWhisperState> {
    if (state.loaded) {
      return this.getState();
    }

    if (loadPromise) {
      await loadPromise;
      return this.getState();
    }

    loadPromise = this.enableInternal().finally(() => {
      loadPromise = null;
    });

    await loadPromise;
    return this.getState();
  }

  private async enableInternal(): Promise<boolean> {
    try {
      const file = await ensureModel();

      setState({ status: "loading", message: "Loading the model into memory…", downloadProgress: 100 });

      whisper = createWhisper(file);
      await whisper.load();

      setState({
        status: "ready",
        message: "Whisper is loaded in memory and transcribing on this Mac.",
        loaded: true
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState({ status: "error", message, loaded: false });
      return false;
    }
  }

  /** Releases the model so it stops occupying memory while the app runs. */
  async disable(): Promise<LocalWhisperState> {
    if (whisper) {
      try {
        await whisper.free();
      } catch (error) {
        logger.warn("Failed to free the whisper model cleanly", { error: String(error) });
      }
      whisper = null;
    }

    setState({
      status: "off",
      message: "Whisper is not loaded. No model is held in memory.",
      loaded: false,
      downloadProgress: 0
    });

    return this.getState();
  }

  /** Loads the model if needed, then transcribes mono 16 kHz PCM. */
  async transcribe(pcm: Float32Array): Promise<string> {
    if (!state.loaded && !(await this.enableInternal())) {
      throw new Error(state.message || "The local Whisper model is not available.");
    }

    if (!whisper) {
      throw new Error("The local Whisper model is not available.");
    }

    const task = await whisper.transcribe(pcm, {
      language: "en",
      print_progress: false,
      print_realtime: false,
      print_timestamps: false
    });

    const segments = await task.result;
    return segments
      .map((segment) => segment.text)
      .join("")
      .trim();
  }

  async ensureLoaded(): Promise<boolean> {
    if (state.loaded) {
      return true;
    }
    return this.enableInternal();
  }
}
