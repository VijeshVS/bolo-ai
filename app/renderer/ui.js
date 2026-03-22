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

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let silenceInterval = null;
let audioContext = null;
let analyser = null;
let isRecording = false;

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
              <div class="history-timestamp">${dateStr} ${timeStr}</div>
              <span class="history-intent">${record.intent}</span>
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

        setStatus("Transcribing and formatting...");

        const result = await window.boloApi.processAudio(arrayBuffer, blobType);
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
  anthropic: {
    label: "Anthropic",
    credentials: [
      { name: "apiKey", label: "API Key", type: "password", required: false }
    ],
    models: [
      { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (default)" },
      { value: "claude-3-opus-20250219", label: "Claude 3 Opus" },
      { value: "claude-3-haiku-20250307", label: "Claude 3 Haiku" }
    ]
  },
  google: {
    label: "Google",
    credentials: [
      { name: "apiKey", label: "API Key", type: "password", required: false }
    ],
    models: [
      { value: "gemini-2.5-pro", label: "gemini-2.5-pro (free with limits)" },
      { value: "gemini-2.5-flash", label: "gemini-2.5-flash (free, default fast model)" },
      { value: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite (free, cheapest + fastest)" }
    ]
  },
  xai: {
    label: "XAI",
    credentials: [
      { name: "apiKey", label: "API Key", type: "password", required: false }
    ],
    models: [
      { value: "grok-2-latest", label: "Grok 2 (default)" }
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
  google: {
    label: "Google Speech-to-Text",
    credentials: [
      { name: "projectId", label: "Project ID", type: "text", required: false },
      { name: "credentialsPath", label: "Credentials File Path", type: "text", required: false, hint: "Path to service account JSON file" }
    ],
    models: []
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
    fieldContainer.className = "settings-group credential-field visible";
    
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
    llmTypeSelect.value = llmConfig.type;
    updateModelOptions(llmConfig.type, LLM_PROVIDERS, llmModelSelect);
    
    if (llmConfig[llmConfig.type]?.model) {
      llmModelSelect.value = llmConfig[llmConfig.type].model;
    }
    
    createCredentialFields(llmConfig.type, llmCredentialsContainer, LLM_PROVIDERS, llmConfig);
    
    // Load Transcriber settings
    const transcriberConfig = settings.transcriber;
    transcriberTypeSelect.value = transcriberConfig.type;
    updateModelOptions(transcriberConfig.type, TRANSCRIBER_PROVIDERS, transcriberModelSelect);
    
    if (transcriberConfig[transcriberConfig.type]?.model) {
      transcriberModelSelect.value = transcriberConfig[transcriberConfig.type].model;
    }
    
    createCredentialFields(transcriberConfig.type, transcriberCredentialsContainer, TRANSCRIBER_PROVIDERS, transcriberConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Failed to load settings: ${message}`, "error");
  }
}

async function saveSettings() {
  try {
    const existingSettings = await window.boloApi.getSettings();
    const llmType = llmTypeSelect.value;
    const transcriberType = transcriberTypeSelect.value;
    
    // Start from existing settings so non-selected providers keep their credentials.
    const llmConfig = {
      ...existingSettings.llm,
      type: llmType,
      openai: existingSettings.llm.openai || { apiKey: "", model: "" },
      anthropic: existingSettings.llm.anthropic || { apiKey: "", model: "" },
      google: existingSettings.llm.google || { apiKey: "", model: "" },
      xai: existingSettings.llm.xai || { apiKey: "", model: "" },
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
      openai: existingSettings.transcriber.openai || { apiKey: "", model: "" },
      google: existingSettings.transcriber.google || { projectId: "", credentialsPath: "" },
      groq: existingSettings.transcriber.groq || { apiKey: "", model: "" }
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
    closeSettings();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Failed to save settings: ${message}`, "error");
  }
}

// Event listeners
settingsButton.addEventListener("click", openSettings);
settingsModalClose.addEventListener("click", closeSettings);
settingsCancel.addEventListener("click", closeSettings);
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
