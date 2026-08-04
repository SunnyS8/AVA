import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { synthesizeSpeech } from "./voice.js";
import { uploadToFal } from "../../core/fal-upload.js";

/** Generate a lip-sync talking-head video via fal.ai SadTalker (queue API). */
export async function generateLipSync(
  text: string,
  voiceConfig: Record<string, unknown>,
  falApiKey: string,
  avatarPath: string,
): Promise<Buffer | null> {
  if (!fs.existsSync(avatarPath)) return null;

  try {
    const audio = await synthesizeSpeech(text, voiceConfig, falApiKey);
    if (!audio) return null;

    const [audioUrl, imageUrl] = await Promise.all([
      uploadToFal(audio, "speech.ogg", falApiKey),
      uploadToFal(fs.readFileSync(avatarPath), "avatar.png", falApiKey),
    ]);

    // Submit to the async queue — sync fal endpoints time out at ~5 min
    const submitRes = await fetch("https://queue.fal.run/fal-ai/sadtalker", {
      method: "POST",
      headers: {
        Authorization: `Key ${falApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        source_image_url: imageUrl,
        driven_audio_url: audioUrl,
        face_model_resolution: "512",
        face_enhancer: "gfpgan",
        expression_scale: 1.2,
        preprocess: "full",
      }),
    });

    if (!submitRes.ok) return null;

    const submitData = (await submitRes.json()) as { request_id?: string };
    const requestId = submitData.request_id;
    if (!requestId) return null;

    // Poll for completion (up to ~9 minutes)
    const deadline = Date.now() + 9 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusRes = await fetch(`https://queue.fal.run/fal-ai/sadtalker/requests/${requestId}/status`, {
        headers: { Authorization: `Key ${falApiKey}`, Accept: "application/json" },
      });
      if (!statusRes.ok) return null;

      const statusData = (await statusRes.json()) as { status?: string };
      const status = statusData.status ?? "";
      if (status === "COMPLETED") break;
      if (status === "FAILED") return null;
    }

    const resultRes = await fetch(`https://queue.fal.run/fal-ai/sadtalker/requests/${requestId}`, {
      headers: { Authorization: `Key ${falApiKey}`, Accept: "application/json" },
    });
    if (!resultRes.ok) return null;

    const result = (await resultRes.json()) as Record<string, unknown>;
    const videoUrl = (result.video as Record<string, unknown>)?.url as string | undefined;
    if (!videoUrl) return null;

    const videoRes = await fetch(videoUrl);
    return Buffer.from(await videoRes.arrayBuffer());
  } catch {
    return null;
  }
}

/** Send a video note (circle) through a grammY context. Falls back to voice. */
export async function sendVideoNote(
  ctx: {
    replyWithVideoNote: (file: unknown) => Promise<unknown>;
    replyWithVideo: (file: unknown) => Promise<unknown>;
    replyWithVoice: (file: unknown) => Promise<unknown>;
  },
  text: string,
  voiceConfig: Record<string, unknown>,
  falApiKey: string,
  avatarPath: string,
): Promise<boolean> {
  const video = await generateLipSync(text, voiceConfig, falApiKey, avatarPath);

  if (!video) {
    // Fall back to voice
    const { sendVoiceResponse } = await import("./voice.js");
    return sendVoiceResponse(ctx, text, voiceConfig, falApiKey);
  }

  const tmpFile = path.join(os.tmpdir(), `betsy-video-${Date.now()}.mp4`);
  try {
    fs.writeFileSync(tmpFile, video);
    const { InputFile } = await import("grammy");
    const file = new InputFile(tmpFile);
    try {
      await ctx.replyWithVideoNote(file);
    } catch {
      await ctx.replyWithVideo(file);
    }
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
