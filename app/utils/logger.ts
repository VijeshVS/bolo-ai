type LogLevel = "INFO" | "WARN" | "ERROR";

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const payload = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[${timestamp}] [${level}] ${message}${payload}`);
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => log("INFO", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("WARN", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("ERROR", message, meta)
};
