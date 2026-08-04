import { uploadToFal } from "../../core/fal-upload.js";

/** Transcribe an audio buffer to text via fal.ai Whisper. */
export async function transcribeSpeech(audioBuffer: Buffer, falApiKey: string): Promise<string | null> {
  if (!falApiKey) return null;

  try {
    const audioUrl = await uploadToFal(audioBuffer, "audio.ogg", falApiKey);
    const res = await fetch("https://fal.run/fal-ai/whisper", {
      method: "POST",
      headers: {
        Authorization: `Key ${falApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        task: "transcribe",
      }),
    });

    if (!res.ok) {
      console.error(`STT fal.ai error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }

    const data = (await res.json()) as { text?: string };
    return (data.text ?? "").trim() || null;
  } catch (err) {
    console.error(`STT exception: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}