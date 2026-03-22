import { clipboard } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { restoreClipboard, saveClipboard } from "../utils/clipboard";

const execFileAsync = promisify(execFile);

async function simulatePasteShortcut(): Promise<void> {
  await execFileAsync("osascript", [
    "-e",
    "tell application \"System Events\" to keystroke \"v\" using command down"
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pasteTextAtCursor(text: string): Promise<void> {
  const snapshot = saveClipboard();

  try {
    clipboard.writeText(text, "clipboard");
    await sleep(70);
    await simulatePasteShortcut();
    await sleep(70);
  } finally {
    restoreClipboard(snapshot);
  }
}
