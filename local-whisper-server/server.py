from fastapi import FastAPI, Query
import os
import threading

import mlx_whisper

app = FastAPI()

# whisper-tiny is the fastest mlx model, which is the point of running locally.
# Override with WHISPER_MODEL to trade some speed for accuracy.
MODEL_PATH = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-tiny-mlx")

# mlx_whisper is not guaranteed to be thread safe, and the app can transcribe
# while this process is still warming up.
_model_lock = threading.Lock()
_model_loaded = False


def _load_model_once():
    global _model_loaded
    if _model_loaded:
        return
    # Touching the model here surfaces a bad WHISPER_MODEL before we claim to be
    # healthy, instead of failing on the first real transcription.
    mlx_whisper.transcribe  # noqa: B018 - attribute presence check
    _model_loaded = True


@app.get("/")
def root():
    return {"message": "Whisper API is running", "model": MODEL_PATH}


@app.get("/health")
def health():
    try:
        _load_model_once()
        return {"status": "success", "model": MODEL_PATH}
    except Exception as exc:  # pragma: no cover - defensive
        return {"status": "error", "message": str(exc)}


@app.get("/transcribe")
def transcribe_audio(audio_path: str = Query(..., description="Path to audio file")):
    if not os.path.exists(audio_path):
        return {"status": "error", "message": f"{audio_path} not found"}

    try:
        with _model_lock:
            result = mlx_whisper.transcribe(
                audio_path,
                path_or_hf_repo=MODEL_PATH,
                language=os.environ.get("WHISPER_LANGUAGE", "en"),
                task="transcribe",
            )

        return {
            "status": "success",
            "audio_path": audio_path,
            "text": result["text"],
        }
    except Exception as exc:
        return {"status": "error", "message": str(exc)}
