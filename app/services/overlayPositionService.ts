import { app } from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";

export interface OverlayPosition {
  x: number;
  y: number;
}

export class OverlayPositionService {
  private positionPath: string;
  private position: OverlayPosition | null = null;

  constructor() {
    this.positionPath = path.join(app.getPath("userData"), "overlay-position.json");
  }

  async init(): Promise<void> {
    try {
      const data = await fs.readFile(this.positionPath, "utf8");
      const parsed = JSON.parse(data) as Partial<OverlayPosition>;

      if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        this.position = { x: parsed.x, y: parsed.y };
        return;
      }

      this.position = null;
    } catch {
      // No saved position yet; the pill falls back to its default placement.
      this.position = null;
    }
  }

  private async save(): Promise<void> {
    if (!this.position) {
      return;
    }

    const tempPath = `${this.positionPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.position), "utf8");
    await fs.rename(tempPath, this.positionPath);
  }

  getPosition(): OverlayPosition | null {
    return this.position ? { ...this.position } : null;
  }

  async updatePosition(x: number, y: number): Promise<void> {
    this.position = { x, y };
    await this.save();
  }
}
