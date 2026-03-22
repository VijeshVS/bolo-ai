import { uIOhook } from "uiohook-napi";
import { logger } from "../utils/logger";

const KEY_LEFT_ALT = 56;
const KEY_RIGHT_ALT = 3640;
const DOUBLE_TAP_WINDOW_MS = 350;
const STOP_TAP_GUARD_MS = 150;

interface HoldHotkeyHandlers {
  onPressStart: () => void;
  onPressEnd: () => void;
}

let isHolding = false;
let hookStarted = false;
let optionTapCount = 0;
let optionTapTimer: NodeJS.Timeout | null = null;
let startedAtMs = 0;
let keydownHandler: ((event: { keycode: number }) => void) | null = null;
let keyupHandler: ((event: { keycode: number }) => void) | null = null;

function resetOptionTapState(): void {
  optionTapCount = 0;
  if (optionTapTimer) {
    clearTimeout(optionTapTimer);
    optionTapTimer = null;
  }
}

function registerOptionTap(handlers: HoldHotkeyHandlers): void {
  if (isHolding) {
    return;
  }

  optionTapCount += 1;

  if (optionTapCount === 1) {
    optionTapTimer = setTimeout(() => {
      resetOptionTapState();
    }, DOUBLE_TAP_WINDOW_MS);
    return;
  }

  if (optionTapCount >= 2) {
    resetOptionTapState();
    isHolding = true;
    startedAtMs = Date.now();
    handlers.onPressStart();
  }
}

function stopHoldIfActive(onPressEnd: () => void): void {
  if (!isHolding) {
    return;
  }

  isHolding = false;
  startedAtMs = 0;
  resetOptionTapState();
  onPressEnd();
}

export function registerHoldHotkey(handlers: HoldHotkeyHandlers): void {
  if (hookStarted) {
    return;
  }

  keydownHandler = () => {
    // Start/stop is managed via Option keyup taps to avoid text insertion keys.
  };

  keyupHandler = (event) => {
    if (event.keycode === KEY_LEFT_ALT || event.keycode === KEY_RIGHT_ALT) {
      if (isHolding) {
        if (Date.now() - startedAtMs < STOP_TAP_GUARD_MS) {
          return;
        }

        stopHoldIfActive(handlers.onPressEnd);
        return;
      }

      registerOptionTap(handlers);
    }
  };

  uIOhook.on("keydown", keydownHandler);
  uIOhook.on("keyup", keyupHandler);
  uIOhook.start();
  hookStarted = true;

  logger.info("Trigger hotkey registered", { combo: "Double-tap Option to record, tap Option once to transcribe" });
}

export function unregisterHoldHotkey(): void {
  if (!hookStarted) {
    return;
  }

  if (keydownHandler) {
    uIOhook.off("keydown", keydownHandler);
  }

  if (keyupHandler) {
    uIOhook.off("keyup", keyupHandler);
  }

  try {
    uIOhook.stop();
  } catch {
    // Ignore stop errors during shutdown.
  }

  keydownHandler = null;
  keyupHandler = null;
  isHolding = false;
  startedAtMs = 0;
  resetOptionTapState();
  hookStarted = false;

  logger.info("Trigger hotkey unregistered", { combo: "Double-tap Option to record, tap Option once to transcribe" });
}
