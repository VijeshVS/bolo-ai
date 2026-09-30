import { spawn, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { logger } from "../utils/logger";

export type LocalWhisperStatus = "stopped" | "starting" | "running" | "missing-dependencies" | "error";

export interface LocalWhisperState {
  status: LocalWhisperStatus;
  message: string;
  port: number;
}

const DEFAULT_PORT = 8000;
const READY_TIMEOUT_MS = 45_000;
const READY_POLL_MS = 400;
const PROBE_TIMEOUT_MS = 2_000;

let child: ChildProcess | null = null;
let currentStatus: LocalWhisperStatus = "stopped";
let currentMessage = "";
let startPromise: Promise<boolean> | null = null;
let stopping = false;

export class LocalWhisperService {
  private port = DEFAULT_PORT;

  getPort(): number {
    return this.port;
  }

  setPort(port: number): void {
    this.port = port;
  }

  getState(): LocalWhisperState {
    return { status: currentStatus, message: currentMessage, port: this.port };
  }

  private setStatus(status: LocalWhisperStatus, message = ""): void {
    currentStatus = status;
    currentMessage = message;
    logger.info("Local whisper server state", { status, message, port: this.port });
  }

  private serverDir(): string {
    // Packaged builds keep local-whisper-server next to the app resources; in
    // development it sits at the project root.
    const candidates = [
      path.join(app.getAppPath(), "local-whisper-server"),
      path.join(process.resourcesPath ?? "", "local-whisper-server")
    ];

    return candidates.find((dir) => existsSync(path.join(dir, "server.py"))) ?? candidates[0];
  }

  private requirementsPath(): string {
    return path.join(this.serverDir(), "requirements.txt");
  }

  /** True when the server answers on its port, whether we started it or not. */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Installs the Python dependencies. Kept as an explicit, user-triggered step
   * because it mutates the machine's Python environment.
   */
  async installDependencies(): Promise<{ ok: boolean; message: string }> {
    const requirements = this.requirementsPath();

    if (!existsSync(requirements)) {
      return { ok: false, message: `requirements.txt not found at ${requirements}` };
    }

    return new Promise((resolve) => {
      const pip = spawn("python3", ["-m", "pip", "install", "-r", requirements], {
        cwd: this.serverDir()
      });

      let output = "";

      pip.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      pip.stderr?.on("data", (chunk) => {
        output += String(chunk);
      });

      pip.on("error", (error) => {
        resolve({ ok: false, message: `Could not run python3: ${String(error)}` });
      });

      pip.on("close", (code) => {
        if (code === 0) {
          resolve({ ok: true, message: output.trim().split("\n").slice(-1)[0] ?? "Dependencies installed." });
          return;
        }

        resolve({
          ok: false,
          message: output.trim().split("\n").slice(-3).join("\n") || `pip exited with code ${code}`
        });
      });
    });
  }

  /** True when every import the server needs is already available. */
  async hasDependencies(): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = spawn("python3", ["-c", "import fastapi, uvicorn, mlx_whisper"]);

      probe.on("error", () => resolve(false));
      probe.on("close", (code) => resolve(code === 0));
    });
  }

  async start(): Promise<boolean> {
    if (startPromise) {
      return startPromise;
    }

    startPromise = this.startInternal().finally(() => {
      startPromise = null;
    });

    return startPromise;
  }

  private async startInternal(): Promise<boolean> {
    if (child) {
      return true;
    }

    // Reuse a server that is already listening, e.g. started by hand.
    if (await this.isHealthy()) {
      this.setStatus("running", "Using the server already listening on this port.");
      return true;
    }

    if (!(await this.hasDependencies())) {
      this.setStatus(
        "missing-dependencies",
        "Python packages are missing. Install them to use local transcription."
      );
      return false;
    }

    const dir = this.serverDir();

    if (!existsSync(path.join(dir, "server.py"))) {
      this.setStatus("error", `server.py not found in ${dir}`);
      return false;
    }

    this.setStatus("starting", "Starting the local transcription server...");

    child = spawn(
      "python3",
      ["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", String(this.port)],
      { cwd: dir }
    );

    stopping = false;

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      logger.error("Local whisper server failed to spawn", { error: String(error) });
      this.setStatus("error", `Could not start the server: ${String(error)}`);
    });

    child.on("exit", (code) => {
      child = null;
      if (stopping) {
        this.setStatus("stopped", "");
        return;
      }
      this.setStatus(
        "error",
        `The server exited unexpectedly (code ${code}).${stderr ? ` ${stderr.trim().split("\n").slice(-1)[0]}` : ""}`
      );
    });

    const ready = await this.waitForReady();
    stopping = false;

    if (ready) {
      this.setStatus("running", "Local transcription server is running.");
      return true;
    }

    this.stop();
    this.setStatus("error", "The server did not become ready in time.");
    return false;
  }

  private async waitForReady(): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (!child) {
        return false;
      }

      if (await this.isHealthy()) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }

    return false;
  }

  stop(): void {
    if (!child) {
      this.setStatus("stopped", "");
      return;
    }

    stopping = true;
    child.kill("SIGTERM");
    child = null;
    this.setStatus("stopped", "");
  }

  /**
   * Called before every local transcription. Cheap when the server is already
   * up, and starts it if the app was launched with the setting already on.
   */
  async ensureRunning(): Promise<boolean> {
    if (currentStatus === "running") {
      if (await this.isHealthy()) {
        return true;
      }
      // The process died without us noticing; try to bring it back.
      child = null;
    }

    return this.start();
  }
}
