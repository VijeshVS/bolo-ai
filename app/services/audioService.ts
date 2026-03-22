import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const AUDIO_DIR = path.join(tmpdir(), "bolo-ai");

function mimeTypeToExtension(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp3") || mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("m4a") || mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("webm")) return "webm";
  return "webm";
}

export async function saveAudioBufferToTempFile(audioBuffer: Buffer, mimeType: string): Promise<string> {
  await fs.mkdir(AUDIO_DIR, { recursive: true });

  const extension = mimeTypeToExtension(mimeType);
  const filePath = path.join(AUDIO_DIR, `recording-${Date.now()}.${extension}`);

  await fs.writeFile(filePath, audioBuffer);

  return filePath;
}

export async function removeTempAudioFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}
