(function () {
  const PILL_WIDTH = 112;
  const PILL_HEIGHT = 36;

  const BAR_COUNT = 13;
  const BAR_WIDTH = 2.5;
  const BAR_GAP = 2.4;
  const MAX_BAR_HEIGHT = 14;
  const MIN_BAR_HEIGHT = 2;
  const BAR_RADIUS = BAR_WIDTH / 2;
  const TWO_PI = Math.PI * 2;

  // Resting profile: a flat, static line with a slight centre swell. Nothing
  // moves until a recording actually starts.
  const REST_BASE = 0.09;
  const REST_SWELL = 0.05;

  // While live: one full cycle of a travelling wave spans the pill, so the
  // motion reads as a single continuous waveform rather than a spectrum readout.
  const WAVE_SPEED = 2.1;
  const LIVE_WAVE_AMPLITUDE = 0.34;
  const LIVE_GAIN = 1.6;
  const SHIMMER_SPEED = 3.1;
  const SHIMMER_STEP = 0.5;

  const REST_ALPHA = 0.34;
  const LIVE_ALPHA = 0.95;
  const REST_COLOR = [255, 255, 255];
  const LIVE_COLOR = [242, 160, 75];

  const RESPONSE_TAU_MS = 60;
  const ACTIVE_TAU_MS = 130;

  // Pointer travel before the cursor switches to the grabbing affordance.
  const DRAG_CURSOR_THRESHOLD = 4;

  const pill = document.getElementById("pill");
  const canvas = document.getElementById("waveform");
  const context = canvas.getContext("2d");

  const barWidthTotal = BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP;
  const barsOriginX = (PILL_WIDTH - barWidthTotal) / 2;
  const barsCenterY = PILL_HEIGHT / 2;

  const heights = new Float32Array(BAR_COUNT);
  const targets = new Float32Array(BAR_COUNT);
  const envelopes = new Float32Array(BAR_COUNT);
  const restHeights = new Float32Array(BAR_COUNT);

  for (let i = 0; i < BAR_COUNT; i += 1) {
    const envelope = Math.sin((Math.PI * (i + 0.5)) / BAR_COUNT);
    envelopes[i] = envelope;
    restHeights[i] = REST_BASE + REST_SWELL * envelope;
  }

  let pixelRatio = 1;
  let phase = 0;
  let energy = 0;
  let active = false;
  let liveMix = 0;
  let previousFrame = 0;

  let pointerDown = false;
  let dragTravel = 0;
  let lastClientX = 0;
  let lastClientY = 0;
  let pendingDragEvent = null;
  let dragFrameQueued = false;

  function resizeCanvas() {
    pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.round(PILL_WIDTH * pixelRatio);
    canvas.height = Math.round(PILL_HEIGHT * pixelRatio);
    canvas.style.width = `${PILL_WIDTH}px`;
    canvas.style.height = `${PILL_HEIGHT}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  function computeTargets() {
    if (!active) {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        targets[i] = restHeights[i];
      }
      return;
    }

    for (let i = 0; i < BAR_COUNT; i += 1) {
      const position = i / (BAR_COUNT - 1);
      const travel = 0.5 + 0.5 * Math.sin(TWO_PI * position - phase * WAVE_SPEED);
      const shimmer = 0.8 + 0.2 * Math.sin(phase * SHIMMER_SPEED - i * SHIMMER_STEP);
      const envelope = envelopes[i];

      targets[i] = Math.min(
        1,
        restHeights[i] +
          LIVE_WAVE_AMPLITUDE * travel * envelope +
          energy * envelope * LIVE_GAIN * shimmer
      );
    }
  }

  function draw() {
    context.clearRect(0, 0, PILL_WIDTH, PILL_HEIGHT);

    const r = Math.round(REST_COLOR[0] + (LIVE_COLOR[0] - REST_COLOR[0]) * liveMix);
    const g = Math.round(REST_COLOR[1] + (LIVE_COLOR[1] - REST_COLOR[1]) * liveMix);
    const b = Math.round(REST_COLOR[2] + (LIVE_COLOR[2] - REST_COLOR[2]) * liveMix);
    const alpha = REST_ALPHA + (LIVE_ALPHA - REST_ALPHA) * liveMix;

    context.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;

    for (let i = 0; i < BAR_COUNT; i += 1) {
      const height = Math.max(MIN_BAR_HEIGHT, heights[i] * MAX_BAR_HEIGHT);
      const x = barsOriginX + i * (BAR_WIDTH + BAR_GAP);
      const y = barsCenterY - height / 2;

      context.beginPath();
      context.roundRect(x, y, BAR_WIDTH, height, BAR_RADIUS);
      context.fill();
    }
  }

  function frame(timestamp) {
    const dt = previousFrame ? Math.min(64, timestamp - previousFrame) : 16;
    previousFrame = timestamp;

    // Time only advances while a recording is running, so the resting
    // waveform is genuinely still rather than slowly breathing.
    if (active) {
      phase += dt / 1000;
    }

    const follow = 1 - Math.exp(-dt / RESPONSE_TAU_MS);
    const activeFollow = 1 - Math.exp(-dt / ACTIVE_TAU_MS);

    liveMix += ((active ? 1 : 0) - liveMix) * activeFollow;
    if (!active && liveMix < 0.002) {
      liveMix = 0;
    }

    computeTargets();

    for (let i = 0; i < BAR_COUNT; i += 1) {
      heights[i] += (targets[i] - heights[i]) * follow;
    }

    draw();
    window.requestAnimationFrame(frame);
  }

  // ---- Dragging and click -------------------------------------------------
  //
  // The main process decides whether a gesture was a click or a drag. The
  // renderer only reports the press, the movement it can see (used only when
  // the global pointer hook is unavailable) and the release.
  //
  // The drag is deliberately NOT ended when the cursor leaves this window: the
  // capsule is small, so a quick flick puts the cursor outside it, and treating
  // that as the end of the gesture is what made dragging stall and snap back.

  function flushDragEvent() {
    dragFrameQueued = false;

    if (!pendingDragEvent) {
      return;
    }

    window.boloApi.overlayDragMove(pendingDragEvent.dx, pendingDragEvent.dy);
    pendingDragEvent = null;
  }

  function queueDragEvent(dx, dy) {
    if (pendingDragEvent) {
      pendingDragEvent.dx += dx;
      pendingDragEvent.dy += dy;
    } else {
      pendingDragEvent = { dx, dy };
    }

    if (!dragFrameQueued) {
      dragFrameQueued = true;
      window.requestAnimationFrame(flushDragEvent);
    }
  }

  pill.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    pointerDown = true;
    lastClientX = event.clientX;
    lastClientY = event.clientY;
    window.boloApi.overlayDragBegin();
  });

  window.addEventListener("mousemove", (event) => {
    if (!pointerDown) {
      return;
    }

    const dx = event.clientX - lastClientX;
    const dy = event.clientY - lastClientY;

    dragTravel += Math.hypot(dx, dy);
    lastClientX = event.clientX;
    lastClientY = event.clientY;

    if (dragTravel >= DRAG_CURSOR_THRESHOLD) {
      pill.classList.add("dragging");
    }

    // Deltas within the window, not absolute screen coordinates: the capsule
    // moves with the pointer, so client coordinates stay stable.
    queueDragEvent(dx, dy);
  });

  window.addEventListener("mouseup", () => {
    if (!pointerDown) {
      return;
    }

    pointerDown = false;
    pill.classList.remove("dragging");

    if (dragFrameQueued) {
      dragFrameQueued = false;
      pendingDragEvent = null;
    }

    window.boloApi.overlayDragEnd(Math.round(dragTravel));
    dragTravel = 0;
  });

  window.boloApi.onOverlayLevel((payload) => {
    active = Boolean(payload.active);
    energy = typeof payload.level === "number" && Number.isFinite(payload.level)
      ? Math.min(1, Math.max(0, payload.level))
      : 0;

    pill.classList.toggle("live", active);
  });

  // Right-click opens the native menu from the main process; the pill itself
  // carries no visible controls.
  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    window.boloApi.overlayContextMenuRequested(event.clientX, event.clientY);
  });

  window.addEventListener("resize", resizeCanvas);

  resizeCanvas();
  window.requestAnimationFrame(frame);
})();
