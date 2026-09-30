const statusEl = document.getElementById("status");
const toggleRecordButton = document.getElementById("toggleRecord");
const checkPermissionsButton = document.getElementById("checkPermissions");
const lastOutputEl = document.getElementById("lastOutput");
const clearHistoryButton = document.getElementById("clearHistory");
const totalWordsEl = document.getElementById("totalWords");
const totalTokensEl = document.getElementById("totalTokens");
const totalRecordingsEl = document.getElementById("totalRecordings");
const totalCostEl = document.getElementById("costAmount");
const recentHistoryEl = document.getElementById("recentHistory");
const windowSurface = document.getElementById("windowSurface");

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let silenceInterval = null;
let audioContext = null;
let analyser = null;
let isRecording = false;
let levelInterval = null;

function setStatus(message, kind = "normal") {
  statusEl.textContent = message;
  statusEl.classList.remove("recording", "error");
  if (kind === "recording") statusEl.classList.add("recording");
  if (kind === "error") statusEl.classList.add("error");
}

function updateRecordButton() {
  toggleRecordButton.textContent = isRecording ? "Stop Recording" : "Start Recording";
}

function preferredMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/wav"];
  for (const candidate of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "";
}

function startSilenceDetection() {
  if (!mediaStream) {
    return;
  }

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const dataArray = new Float32Array(analyser.fftSize);
  let silenceMs = 0;

  silenceInterval = setInterval(() => {
    if (!analyser || !isRecording) {
      return;
    }

    analyser.getFloatTimeDomainData(dataArray);
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i += 1) {
      sumSquares += dataArray[i] * dataArray[i];
    }

    const rms = Math.sqrt(sumSquares / dataArray.length);

    if (rms < 0.012) {
      silenceMs += 200;
    } else {
      silenceMs = 0;
    }

    if (silenceMs >= 2000) {
      void stopRecording("Stopped after silence");
    }
  }, 200);
}

function stopSilenceDetection() {
  if (silenceInterval) {
    clearInterval(silenceInterval);
    silenceInterval = null;
  }

  if (audioContext) {
    void audioContext.close();
    audioContext = null;
  }

  analyser = null;
}

// ============ FLOATING OVERLAY MORPH ============

/*
 * The surface's shape, veil and content fade are computed from the window's
 * current height rather than driven by CSS transitions. A transition started
 * while the window is still hidden never runs, which would leave the expanded
 * app stuck in the pill's shape. Deriving them from the height keeps every
 * visual property in step with the main-process bounds animation.
 */
const MORPH_APP_RADIUS = 20;
const MORPH_PILL_EXTRA_RADIUS = -2;
const MORPH_RADIUS_FALLOFF = 45;
const MORPH_VEIL_SPAN = 120;
const MORPH_CONTENT_START = 150;
const MORPH_CONTENT_SPAN = 110;
const MORPH_CONTENT_MIN_SCALE = 0.96;

let morphing = false;
let morphPillHeight = 78;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function applyMorphFrame(height) {
  const grown = height - morphPillHeight;

  // The pill look is held until the window is genuinely app-sized, so the
  // collapse passes through a dark rounded frame instead of showing cropped
  // app content at window sizes that cannot display it.
  const radius =
    MORPH_APP_RADIUS + MORPH_PILL_EXTRA_RADIUS * Math.exp(-grown / MORPH_RADIUS_FALLOFF);
  const veil = 1 - smoothstep(grown / MORPH_VEIL_SPAN);
  const content = smoothstep((height - MORPH_CONTENT_START) / MORPH_CONTENT_SPAN);

  windowSurface.style.borderRadius = `${radius.toFixed(2)}px`;
  windowSurface.style.setProperty("--veil", veil.toFixed(3));
  windowSurface.style.setProperty("--content-opacity", content.toFixed(3));
  windowSurface.style.setProperty(
    "--content-scale",
    (MORPH_CONTENT_MIN_SCALE + (1 - MORPH_CONTENT_MIN_SCALE) * content).toFixed(3)
  );
}

function releaseMorphFrame() {
  windowSurface.style.removeProperty("border-radius");
  windowSurface.style.removeProperty("--veil");
  windowSurface.style.removeProperty("--content-opacity");
  windowSurface.style.removeProperty("--content-scale");
}

window.addEventListener("resize", () => {
  if (morphing) {
    applyMorphFrame(window.innerHeight);
  }
});

window.boloApi.onMorphExpand((payload) => {
  morphing = true;
  morphPillHeight = payload.pillHeight;
  // Pinned to the pill height: the window has not been resized yet, and it
  // must already be pill-shaped the instant it becomes visible.
  applyMorphFrame(morphPillHeight);
  window.boloApi.sendMorphReady();
});

window.boloApi.onMorphCollapse((payload) => {
  morphing = true;
  applyMorphFrame(window.innerHeight);
});

window.boloApi.onMorphSettled(() => {
  morphing = false;
  releaseMorphFrame();
});

// ============ WINDOW CONTROLS ============

// The window is transparent so it can morph in and out of the floating
// capsule, which means macOS never draws native traffic lights. These drive the
// app's own macOS-styled controls instead.
document.getElementById("windowClose").addEventListener("click", () => {
  window.boloApi.windowAction("close");
});

document.getElementById("windowMinimize").addEventListener("click", () => {
  window.boloApi.windowAction("minimize");
});

document.getElementById("windowZoom").addEventListener("click", () => {
  window.boloApi.windowAction("zoom");
});

// ============ AUDIO LEVEL METER ============

// whisper.cpp consumes mono 16 kHz PCM, so the recorded blob is decoded and
// resampled in the renderer where Web Audio already lives.
const WHISPER_SAMPLE_RATE = 16000;

async function decodeToMono16k(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeContext = new AudioContext();

  try {
    const decoded = await decodeContext.decodeAudioData(arrayBuffer);
    const source = decoded;
    const frames = Math.round((source.duration * WHISPER_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, Math.max(1, frames), WHISPER_SAMPLE_RATE);
    const node = offline.createBufferSource();
    node.buffer = source;
    node.connect(offline.destination);
    node.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    void decodeContext.close();
  }
}

const LEVEL_SAMPLE_INTERVAL_MS = 50;
const LEVEL_NOISE_FLOOR = 0.008;
const LEVEL_RANGE = 0.22;

function startLevelMeter() {
  if (!mediaStream || audioContext) {
    return;
  }

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  // Announce the live state immediately, before any audio has arrived, so the
  // capsule comes alive the moment recording starts rather than on first sound.
  window.boloApi.sendAudioLevel(0, true);

  const dataArray = new Float32Array(analyser.fftSize);
  let lastSentAt = 0;

  levelInterval = setInterval(() => {
    if (!analyser) {
      return;
    }

    analyser.getFloatTimeDomainData(dataArray);

    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i += 1) {
      sumSquares += dataArray[i] * dataArray[i];
    }

    const rms = Math.sqrt(sumSquares / dataArray.length);
    const level = Math.min(1, Math.max(0, (rms - LEVEL_NOISE_FLOOR) / LEVEL_RANGE));

    const now = Date.now();
    if (now - lastSentAt < LEVEL_SAMPLE_INTERVAL_MS) {
      return;
    }

    lastSentAt = now;
    window.boloApi.sendAudioLevel(level, true);
  }, LEVEL_SAMPLE_INTERVAL_MS);
}

function stopLevelMeter() {
  if (levelInterval) {
    clearInterval(levelInterval);
    levelInterval = null;
  }

  window.boloApi.sendAudioLevel(0, false);
}

async function refreshAnalytics() {
  try {
    const analytics = await window.boloApi.getHistoryAnalytics();
    totalWordsEl.textContent = analytics.totalWords.toLocaleString();
    totalTokensEl.textContent = analytics.totalTokens.toLocaleString();
    totalRecordingsEl.textContent = analytics.totalRecordings.toString();
    totalCostEl.textContent = analytics.totalCost.toFixed(4);

    if (analytics.records && analytics.records.length > 0) {
      recentHistoryEl.innerHTML = analytics.records
        .slice(0, 10)
        .map((record) => {
          const date = new Date(record.timestamp);
          const timeStr = date.toLocaleTimeString();
          const dateStr = date.toLocaleDateString();
          return `
            <div class="history-item">
              <div class="history-meta">
                <span class="history-intent">${escapeHtml(record.intent)}</span>
                <span class="history-timestamp">${dateStr} ${timeStr}</span>
              </div>
              <div class="history-text">${escapeHtml(record.outputText.substring(0, 150))}${record.outputText.length > 150 ? "..." : ""}</div>
            </div>
          `;
        })
        .join("");
    } else {
      recentHistoryEl.innerHTML = '<p class="hint">No history yet.</p>';
    }
  } catch (error) {
    console.error("Failed to refresh analytics:", error);
  }
}

function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

async function startRecording() {
  if (isRecording) {
    return;
  }

  try {
    setStatus("Checking permissions...");
    const permissions = await window.boloApi.checkPermissions({ requestMicrophone: true });

    if (permissions.microphone !== "granted") {
      setStatus("Microphone permission denied. Enable it in System Settings.", "error");
      return;
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startLevelMeter();

    const mimeType = preferredMimeType();
    mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);

    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      try {
        const blobType = mediaRecorder.mimeType || "audio/webm";
        const blob = new Blob(audioChunks, { type: blobType });
        const arrayBuffer = await blob.arrayBuffer();

        const useLocal = (await window.boloApi.getSettings()).transcriber.localWhisperEnabled === true;
        const pcm = useLocal ? await decodeToMono16k(blob) : undefined;

        setStatus(useLocal ? "Transcribing on this Mac..." : "Transcribing and formatting...");

        const result = await window.boloApi.processAudio(arrayBuffer, blobType, pcm);
        lastOutputEl.textContent = result.outputText || "(empty output)";
        setStatus(`Done. Intent: ${result.intent}`);
        
        // Refresh analytics after successful transcription
        await refreshAnalytics();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Failed: ${message}`, "error");
      }
    };

    mediaRecorder.start(250);
    isRecording = true;
    updateRecordButton();
    setStatus("Recording... Speak now", "recording");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Failed to start recording: ${message}`, "error");
    isRecording = false;
    updateRecordButton();
  }
}

async function stopRecording(reason) {
  if (!isRecording) {
    return;
  }

  stopLevelMeter();
  stopSilenceDetection();

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  isRecording = false;
  updateRecordButton();
  setStatus(reason || "Stopped recording");
}

async function toggleRecording() {
  if (isRecording) {
    await stopRecording("Stopped manually");
    return;
  }

  await startRecording();
}

toggleRecordButton.addEventListener("click", () => {
  void toggleRecording();
});

checkPermissionsButton.addEventListener("click", async () => {
  try {
    const permissions = await window.boloApi.checkPermissions({
      requestMicrophone: false,
      promptAccessibility: true
    });

    if (!permissions.accessibility) {
      setStatus("Accessibility permission is required for system paste.", "error");
      return;
    }

    if (permissions.microphone !== "granted") {
      setStatus("Microphone permission not granted yet.", "error");
      return;
    }

    setStatus("Permissions look good.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Permission check failed: ${message}`, "error");
  }
});

window.boloApi.onHotkeyStartRecording(() => {
  if (!isRecording) {
    void startRecording();
  }
});

window.boloApi.onHotkeyStopRecording(() => {
  if (isRecording) {
    void stopRecording("Stopped on Option tap");
  }
});

setStatus("Ready. Double-tap Option to record, then tap Option once to transcribe and paste.");
updateRecordButton();

// Load analytics on startup
void refreshAnalytics();

// Clear history button listener
clearHistoryButton.addEventListener("click", async () => {
  if (confirm("Are you sure you want to clear all transcription history?")) {
    try {
      await window.boloApi.clearHistory();
      setStatus("History cleared.");
      await refreshAnalytics();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Failed to clear history: ${message}`, "error");
    }
  }
});

// ============ SETTINGS MODAL LOGIC ============

const settingsModal = document.getElementById("settingsModal");
const settingsButton = document.getElementById("settingsButton");
const settingsModalClose = document.getElementById("settingsModalClose");
const settingsCancel = document.getElementById("settingsCancel");
const settingsSave = document.getElementById("settingsSave");

const llmTypeSelect = document.getElementById("llmType");
const llmModelSelect = document.getElementById("llmModel");
const llmCredentialsContainer = document.getElementById("llmCredentialsContainer");

const localWhisperToggle = document.getElementById("localWhisperToggle");
const localWhisperStatus = document.getElementById("localWhisperStatus");
const localWhisperStatusText = document.getElementById("localWhisperStatusText");
const externalTranscriber = document.getElementById("externalTranscriber");
const correctionToggle = document.getElementById("correctionToggle");
const llmControls = document.getElementById("llmControls");

let localWhisperEnabled = false;
let localWhisperPoll = null;
let correctionEnabled = true;

const transcriberTypeSelect = document.getElementById("transcriberType");
const transcriberModelSelect = document.getElementById("transcriberModel");
const transcriberCredentialsContainer = document.getElementById("transcriberCredentialsContainer");

// Provider credential specifications
const LLM_PROVIDERS = {
  openai: {
    label: "OpenAI",
    credentials: [
      { name: "apiKey", label: "API Key", type: "password", required: false }
    ],
    models: [
      { value: "gpt-5-nano", label: "gpt-5-nano ($0.05 / $0.4 per 1M tokens)" },
      { value: "gpt-5-mini", label: "gpt-5-mini ($0.25 / $2 per 1M tokens)" },
      { value: "gpt-4o-mini", label: "gpt-4o-mini ($0.15 / $0.6 per 1M tokens)" },
      { value: "gpt-4.1-mini", label: "gpt-4.1-mini ($0.4 / $1.6 per 1M tokens)" },
      { value: "gpt-4o", label: "gpt-4o ($2.5 / $10 per 1M tokens)" }
    ]
  },
  groq: {
    label: "Groq",
    credentials: [
      { name: "apiKey", label: "API Key", type: "password", required: false }
    ],
    models: [
      { value: "allam-2-7b", label: "allam-2-7b (30 req/min - free)" },
      { value: "groq/compound", label: "groq/compound (30 req/min - free)" },
      { value: "groq/compound-mini", label: "groq/compound-mini (30 req/min - free)" },
      { value: "llama-3.1-8b-instant", label: "llama-3.1-8b-instant (30 req/min - free)" },
      { value: "llama-3.3-70b-versatile", label: "llama-3.3-70b-versatile (30 req/min - free)" },
      { value: "meta-llama/llama-4-scout-17b-16e-instruct", label: "meta-llama/llama-4-scout-17b-16e-instruct (30 req/min - free)" },
      { value: "meta-llama/llama-prompt-guard-2-22m", label: "meta-llama/llama-prompt-guard-2-22m (30 req/min - free)" },
      { value: "meta-llama/llama-prompt-guard-2-86m", label: "meta-llama/llama-prompt-guard-2-86m (30 req/min - free)" },
      { value: "moonshotai/kimi-k2-instruct", label: "moonshotai/kimi-k2-instruct (60 req/min - free)" },
      { value: "moonshotai/kimi-k2-instruct-0905", label: "moonshotai/kimi-k2-instruct-0905 (60 req/min - free)" },
      { value: "openai/gpt-oss-120b", label: "openai/gpt-oss-120b (30 req/min - free)" },
      { value: "openai/gpt-oss-20b", label: "openai/gpt-oss-20b (30 req/min - free)" },
      { value: "openai/gpt-oss-safeguard-20b", label: "openai/gpt-oss-safeguard-20b (30 req/min - free)" },
      { value: "qwen/qwen3-32b", label: "qwen/qwen3-32b (60 req/min - free)" }
    ]
  },
  openrouter: {
    label: "OpenRouter",
    credentials: [
      { name: "apiKey", label: "API Key", type: "password", required: false }
    ],
    models: [
      { value: "openrouter/free", label: "openrouter/free" }
    ]
  }
};

const TRANSCRIBER_PROVIDERS = {
  openai: {
    label: "OpenAI Transcription",
    credentials: [
      { name: "apiKey", label: "API Key", type: "password", required: false }
    ],
    models: [
      { value: "gpt-4o-mini-transcribe", label: "gpt-4o-mini-transcribe ($0.003/min)" },
      { value: "gpt-4o-transcribe", label: "gpt-4o-transcribe ($0.006/min)" },
      { value: "gpt-4o-transcribe-diarize", label: "gpt-4o-transcribe-diarize ($0.006/min)" }
    ]
  },
  groq: {
    label: "Groq Speech-to-Text",
    credentials: [
      { name: "apiKey", label: "API Key", type: "password", required: false }
    ],
    models: [
      { value: "whisper-large-v3", label: "whisper-large-v3 (20 req/min - free)" },
      { value: "whisper-large-v3-turbo", label: "whisper-large-v3-turbo (20 req/min - free)" }
    ]
  },
  whisper: {
    label: "Whisper (Local)",
    credentials: [],
    models: [
      { value: "whisper", label: "whisper-local" }
    ]
  }
};

function createCredentialFields(provider, containerElement, providerConfig, currentSettings) {
  containerElement.innerHTML = "";
  
  const providerSpec = providerConfig[provider];
  if (!providerSpec || !providerSpec.credentials || providerSpec.credentials.length === 0) {
    return;
  }

  const fieldGroup = document.createElement("div");
  
  providerSpec.credentials.forEach(credSpec => {
    const fieldContainer = document.createElement("div");
    fieldContainer.className = "settings-group credential-field";
    
    const label = document.createElement("label");
    label.htmlFor = `${containerElement.id}_${credSpec.name}`;
    label.textContent = credSpec.label;
    
    const input = document.createElement("input");
    input.id = `${containerElement.id}_${credSpec.name}`;
    input.name = credSpec.name;
    input.type = credSpec.type;
    input.placeholder = `Leave empty to use environment variable`;
    input.dataset.provider = provider;
    input.dataset.credentialName = credSpec.name;
    
    // Load existing value
    if (currentSettings[provider] && currentSettings[provider][credSpec.name]) {
      input.value = currentSettings[provider][credSpec.name];
    }
    
    fieldContainer.appendChild(label);
    fieldContainer.appendChild(input);
    
    if (credSpec.hint) {
      const hint = document.createElement("p");
      hint.className = "settings-hint";
      hint.textContent = credSpec.hint;
      fieldContainer.appendChild(hint);
    } else {
      const hint = document.createElement("p");
      hint.className = "settings-hint";
      hint.textContent = "Stored locally and never sent elsewhere.";
      fieldContainer.appendChild(hint);
    }
    
    fieldGroup.appendChild(fieldContainer);
  });
  
  containerElement.appendChild(fieldGroup);
}

function updateModelOptions(provider, providerConfig, modelSelector) {
  const providerSpec = providerConfig[provider];
  const options = (providerSpec && providerSpec.models) || [];
  
  modelSelector.innerHTML = `<option value="">Default</option>` + options.map(opt => 
    `<option value="${opt.value}">${opt.label}</option>`
  ).join("");
}

function openSettings() {
  settingsModal.classList.add("visible");
  void loadSettingsForm();
}

function closeSettings() {
  settingsModal.classList.remove("visible");
}

async function loadSettingsForm() {
  try {
    const settings = await window.boloApi.getSettings();
    
    // Load LLM settings
    const llmConfig = settings.llm;
    correctionEnabled = llmConfig.correctionEnabled !== false;
    llmTypeSelect.value = llmConfig.type;
    updateModelOptions(llmConfig.type, LLM_PROVIDERS, llmModelSelect);
    
    if (llmConfig[llmConfig.type]?.model) {
      llmModelSelect.value = llmConfig[llmConfig.type].model;
    }
    
    createCredentialFields(llmConfig.type, llmCredentialsContainer, LLM_PROVIDERS, llmConfig);
    
    // Load Transcriber settings
    const transcriberConfig = settings.transcriber;
    localWhisperEnabled = transcriberConfig.localWhisperEnabled === true;
    void refreshLocalWhisperStatus();
    transcriberTypeSelect.value = transcriberConfig.type;
    updateModelOptions(transcriberConfig.type, TRANSCRIBER_PROVIDERS, transcriberModelSelect);
    
    if (transcriberConfig[transcriberConfig.type]?.model) {
      transcriberModelSelect.value = transcriberConfig[transcriberConfig.type].model;
    }
    
    createCredentialFields(transcriberConfig.type, transcriberCredentialsContainer, TRANSCRIBER_PROVIDERS, transcriberConfig);

    // Last, so the credential inputs created above are disabled too.
    renderLocalWhisperToggle();
    renderCorrectionToggle();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Failed to load settings: ${message}`, "error");
  }
}

async function saveSettings(closeWhenDone = true) {
  try {
    const existingSettings = await window.boloApi.getSettings();
    const llmType = llmTypeSelect.value;
    const transcriberType = transcriberTypeSelect.value;
    
    // Start from existing settings so non-selected providers keep their credentials.
    const llmConfig = {
      ...existingSettings.llm,
      type: llmType,
      correctionEnabled,
      openai: existingSettings.llm.openai || { apiKey: "", model: "" },
      groq: existingSettings.llm.groq || { apiKey: "", model: "" },
      openrouter: existingSettings.llm.openrouter || { apiKey: "", model: "" }
    };

    if (!llmConfig[llmType]) {
      llmConfig[llmType] = {};
    }
    
    // Gather LLM credentials
    const llmCredentialInputs = llmCredentialsContainer.querySelectorAll("input");
    llmCredentialInputs.forEach(input => {
      const value = input.value.trim();
      if (value) {
        llmConfig[llmType][input.dataset.credentialName] = value;
      }
    });
    
    // Set LLM model
    const llmModelValue = llmModelSelect.value;
    if (llmModelValue) {
      llmConfig[llmType].model = llmModelValue;
    } else {
      // Keep explicit empty model to use provider default behavior.
      llmConfig[llmType].model = "";
    }
    
    const transcriberConfig = {
      ...existingSettings.transcriber,
      type: transcriberType,
      localWhisperEnabled,
      openai: existingSettings.transcriber.openai || { apiKey: "", model: "" },
      groq: existingSettings.transcriber.groq || { apiKey: "", model: "" },
      whisper: existingSettings.transcriber.whisper || {}
    };

    if (!transcriberConfig[transcriberType]) {
      transcriberConfig[transcriberType] = {};
    }
    
    // Gather Transcriber credentials
    const transcriberCredentialInputs = transcriberCredentialsContainer.querySelectorAll("input");
    transcriberCredentialInputs.forEach(input => {
      const value = input.value.trim();
      if (value) {
        transcriberConfig[transcriberType][input.dataset.credentialName] = value;
      }
    });
    
    // Set Transcriber model
    const transcriberModelValue = transcriberModelSelect.value;
    if (transcriberModelValue && (transcriberType === "openai" || transcriberType === "groq")) {
      transcriberConfig[transcriberType].model = transcriberModelValue;
    } else if (transcriberType === "openai" || transcriberType === "groq") {
      transcriberConfig[transcriberType].model = "";
    }
    
    const finalSettings = {
      llm: llmConfig,
      transcriber: transcriberConfig
    };
    
    await window.boloApi.updateSettings(finalSettings);
    setStatus("Settings saved successfully!");

    if (closeWhenDone) {
      closeSettings();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Failed to save settings: ${message}`, "error");
  }
}

// Event listeners
settingsButton.addEventListener("click", openSettings);
settingsModalClose.addEventListener("click", closeSettings);
settingsCancel.addEventListener("click", closeSettings);
// ============ LOCAL WHISPER SERVER ============

const LOCAL_STATUS_LABELS = {
  off: "No model in memory",
  downloading: "Downloading the model\u2026",
  loading: "Loading the model into memory\u2026",
  ready: "Model loaded in memory",
  error: "The model could not be loaded"
};

/** Reflects a switch's own on/off state. */
function setSwitchState(toggleElement, on) {
  toggleElement.setAttribute("aria-checked", String(on));
}

/**
 * Enables or disables the panel a switch governs. The real `disabled` attribute
 * is set alongside the visual treatment so the controls leave the tab order and
 * cannot be focused.
 */
function setPanelEnabled(container, enabled) {
  container.classList.toggle("is-disabled", !enabled);
  container
    .querySelectorAll("select, input, button")
    .forEach((control) => {
      control.disabled = !enabled;
    });
}

function renderLocalWhisperToggle() {
  setSwitchState(localWhisperToggle, localWhisperEnabled);
  // The external provider section is unusable while local Whisper owns
  // transcription, so it reads as unavailable rather than being silently ignored.
  setPanelEnabled(externalTranscriber, !localWhisperEnabled);
}

function renderCorrectionToggle() {
  setSwitchState(correctionToggle, correctionEnabled);
  setPanelEnabled(llmControls, correctionEnabled);
}

function renderLocalWhisperState(state) {
  localWhisperStatus.dataset.state = state.status;

  let label = LOCAL_STATUS_LABELS[state.status] || LOCAL_STATUS_LABELS.error;
  if (state.status === "downloading" && state.downloadProgress) {
    label = `Downloading the model \u2026 ${state.downloadProgress}%`;
  }
  if (state.loaded) {
    label = `whisper-${state.model} in memory \u2014 ${state.memoryMb} MB used by Bolo AI`;
  }
  // Show the most specific thing available: live progress while downloading,
  // the real cost while loaded, and the actual reason when something failed.
  let text;
  if (state.status === "downloading" && state.downloadProgress) {
    text = `Downloading the model \u2026 ${state.downloadProgress}%`;
  } else if (state.loaded) {
    text = `whisper-${state.model} in memory \u2014 ${state.memoryMb} MB used by Bolo AI`;
  } else {
    text = state.message || LOCAL_STATUS_LABELS[state.status] || LOCAL_STATUS_LABELS.error;
  }
  localWhisperStatusText.textContent = text;

  // The main process starts the download only after it has replied to the save,
  // so a read taken straight after the switch still sees "off". Keep polling
  // whenever the model has not settled rather than only while it looks busy.
  if (localWhisperPoll) {
    clearInterval(localWhisperPoll);
    localWhisperPoll = null;
  }

  const settled = state.status === "ready" || state.status === "error";
  const busy = state.status === "downloading" || state.status === "loading";
  const startingUp = localWhisperEnabled && !settled;

  if (busy || startingUp) {
    localWhisperPoll = setInterval(() => void refreshLocalWhisperStatus(), 700);
  }
}

async function refreshLocalWhisperStatus() {
  try {
    renderLocalWhisperState(await window.boloApi.getLocalWhisperStatus());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Failed to read the local model status: ${message}`, "error");
  }
}

localWhisperToggle.addEventListener("click", async () => {
  localWhisperEnabled = !localWhisperEnabled;
  renderLocalWhisperToggle();

  // Applied immediately rather than waiting for Save, so the model is loaded or
  // released the moment the switch moves. The dialog stays open so the
  // resulting status is visible.
  await saveSettings(false);
  await refreshLocalWhisperStatus();
  // Catch the state the main process moves to just after replying.
  setTimeout(() => void refreshLocalWhisperStatus(), 600);
});

correctionToggle.addEventListener("click", async () => {
  correctionEnabled = !correctionEnabled;
  renderCorrectionToggle();

  // Applied immediately, like the local Whisper switch, and the dialog stays
  // open.
  await saveSettings(false);
});


settingsSave.addEventListener("click", () => void saveSettings());

llmTypeSelect.addEventListener("change", () => {
  const settings = window.boloApi.getSettings().then(s => s.llm);
  settings.then(llmConfig => {
    updateModelOptions(llmTypeSelect.value, LLM_PROVIDERS, llmModelSelect);
    createCredentialFields(llmTypeSelect.value, llmCredentialsContainer, LLM_PROVIDERS, llmConfig);
  });
});

transcriberTypeSelect.addEventListener("change", () => {
  const settings = window.boloApi.getSettings().then(s => s.transcriber);
  settings.then(transcriberConfig => {
    updateModelOptions(transcriberTypeSelect.value, TRANSCRIBER_PROVIDERS, transcriberModelSelect);
    createCredentialFields(transcriberTypeSelect.value, transcriberCredentialsContainer, TRANSCRIBER_PROVIDERS, transcriberConfig);
  });
});

// Close modal when clicking outside
settingsModal.addEventListener("click", (event) => {
  if (event.target === settingsModal) {
    closeSettings();
  }
});
