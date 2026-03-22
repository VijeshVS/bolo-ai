import { promises as fs } from "node:fs";
import path from "node:path";

export interface TranscriptionRecord {
  id: string;
  timestamp: number;
  transcript: string;
  outputText: string;
  intent: string;
  wordCount: number;
  tokenCount: number;
  cost: number;
}

export interface HistoryAnalytics {
  totalRecordings: number;
  totalWords: number;
  totalTokens: number;
  totalCost: number;
  records: TranscriptionRecord[];
}

export class HistoryService {
  private records: TranscriptionRecord[] = [];
  private initialized = false;

  constructor(private readonly storePath: string) {}

  private async readHistory(): Promise<TranscriptionRecord[]> {
    try {
      const data = await fs.readFile(this.storePath, "utf8");
      return JSON.parse(data) as TranscriptionRecord[];
    } catch {
      return [];
    }
  }

  private async writeHistory(): Promise<void> {
    const tempPath = `${this.storePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.records, null, 2), "utf8");
    await fs.rename(tempPath, this.storePath);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    this.records = await this.readHistory();
    this.initialized = true;
  }

  async addRecord(record: Omit<TranscriptionRecord, "id">): Promise<TranscriptionRecord> {
    await this.init();

    const id = `rec-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const fullRecord: TranscriptionRecord = { id, ...record };

    this.records.unshift(fullRecord);
    await this.writeHistory();

    return fullRecord;
  }

  async getAnalytics(): Promise<HistoryAnalytics> {
    await this.init();

    const totalWords = this.records.reduce((sum, rec) => sum + rec.wordCount, 0);
    const totalTokens = this.records.reduce((sum, rec) => sum + rec.tokenCount, 0);
    const totalCost = Math.round(this.records.reduce((sum, rec) => sum + rec.cost, 0) * 10000) / 10000;

    return {
      totalRecordings: this.records.length,
      totalWords,
      totalTokens,
      totalCost,
      records: this.records.slice(0, 50)
    };
  }

  async clearHistory(): Promise<void> {
    await this.init();
    this.records = [];
    await this.writeHistory();
  }
}
