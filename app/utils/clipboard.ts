import { clipboard } from "electron";

export interface ClipboardSnapshot {
  formats: Array<{ format: string; data: Buffer }>;
}

export function saveClipboard(): ClipboardSnapshot {
  const formats = clipboard.availableFormats();
  const snapshot: ClipboardSnapshot = { formats: [] };

  for (const format of formats) {
    try {
      snapshot.formats.push({ format, data: clipboard.readBuffer(format) });
    } catch {
      // Skip unsupported binary formats for restore safety.
    }
  }

  return snapshot;
}

export function restoreClipboard(snapshot: ClipboardSnapshot): void {
  clipboard.clear();

  for (const entry of snapshot.formats) {
    try {
      clipboard.writeBuffer(entry.format, entry.data);
    } catch {
      // Skip failed formats and continue restoring what we can.
    }
  }
}
