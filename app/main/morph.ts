import { BrowserWindow, Rectangle, screen } from "electron";

export const EXPAND_DURATION_MS = 340;
export const COLLAPSE_DURATION_MS = 280;

const FRAME_INTERVAL_MS = 16;
const APP_INSET = 40;
const MIN_APP_WIDTH = 520;
const MIN_APP_HEIGHT = 680;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function lerp(from: number, to: number, progress: number): number {
  return Math.round(from + (to - from) * progress);
}

function interpolate(from: Rectangle, to: Rectangle, progress: number): Rectangle {
  return {
    x: lerp(from.x, to.x, progress),
    y: lerp(from.y, to.y, progress),
    width: lerp(from.width, to.width, progress),
    height: lerp(from.height, to.height, progress)
  };
}

/**
 * Animates a window between two rectangles. Driven manually rather than with
 * `setBounds({ animate: true })` so the easing matches the CSS transition the
 * renderer runs in parallel, which is what makes the pill read as a single
 * object expanding rather than two windows swapping.
 */
export function animateBounds(
  window: BrowserWindow,
  from: Rectangle,
  to: Rectangle,
  durationMs: number
): Promise<void> {
  return new Promise((resolve) => {
    if (durationMs <= 0) {
      window.setBounds(to);
      resolve();
      return;
    }

    const startedAt = Date.now();

    const step = (): void => {
      const elapsed = Date.now() - startedAt;
      const progress = Math.min(1, elapsed / durationMs);

      window.setBounds(interpolate(from, to, easeOutCubic(progress)));

      if (progress >= 1) {
        window.setBounds(to);
        resolve();
        return;
      }

      setTimeout(step, FRAME_INTERVAL_MS);
    };

    step();
  });
}

/**
 * Target frame for the expanded app: the work area of the display the pill is
 * on, inset so the window keeps a visible margin from the screen edges.
 */
export function expandedAppBounds(origin: Rectangle): Rectangle {
  const display = screen.getDisplayMatching(origin);
  const area = display.workArea;

  const width = Math.min(area.width, Math.max(MIN_APP_WIDTH, area.width - APP_INSET * 2));
  const height = Math.min(area.height, Math.max(MIN_APP_HEIGHT, area.height - APP_INSET * 2));

  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height
  };
}
