from fastapi import FastAPI, Query
import mlx_whisper
import os

app = FastAPI()

MODEL_PATH = "mlx-community/whisper-tiny-mlx"

@app.get("/")
def root():
    return {"message": "Whisper API is running"}

@app.get("/transcribe")
def transcribe_audio(audio_path: str = Query(..., description="Path to audio file")):
    
    if not os.path.exists(audio_path):
        return {"error": f"{audio_path} not found"}

    try:
        result = mlx_whisper.transcribe(
            audio_path,
            path_or_hf_repo=MODEL_PATH,
            language="en",
            task="transcribe"
        )

        print("Transcribed audio: ", result)

        return {
            "status": "success",
            "audio_path": audio_path,
            "text": result["text"]
        }

    except Exception as e:
        return {
            "status": "error",
            "message": str(e)
        }