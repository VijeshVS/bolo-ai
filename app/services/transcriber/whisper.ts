import { Transcriber, TranscriptionResult } from ".";

export class WhisperTranscriber implements Transcriber {
    async transcribe(filePath: string): Promise<TranscriptionResult> {
        const response = await fetch(`http://localhost:8000/transcribe?audio_path=${encodeURIComponent(filePath)}`)
        const data = await response.text();
        const {status, audio_path, text} = JSON.parse(data);
        
        if(status != "success"){
            throw new Error(`Failed to transcribe audio: ${audio_path}`);
        }

        return {text , cost : 0}
    }
}