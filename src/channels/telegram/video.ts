import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { synthesizeSpeech } from "./voice.js";
import { uploadToFal } from "../../core/fal-upload.js";
import { estimateAudioDurationSeconds } from "../../core/audio-duration.js";

/**
 * Lip-sync models on fal.ai, picked by speech length.
 *
 * ByteDance OmniHuman gives the best lip/head motion but costs $0.14 per second
 * and refuses audio of 30 seconds or more. Kling AI Avatar v2 (standard) has no
 * such cap and costs $0.0562 per second, so long speech goes there instead of
 * being refused.
 */
export const LIPSYNC_MODEL_SHORT = "fal-ai/bytedance/omnihuman";
export const LIPSYNC_MODEL_LONG = "fal-ai/kling-video/ai-avatar/v2/standard";

/**
 * Hard audio limit of OmniHuman: its fal.ai model page states the audio "must be
 * under 30s long" (checked 2026-08-08). Anything longer is routed to Kling.
 */
export const OMNIHUMAN_MAX_AUDIO_SECONDS = 30;

/**
 * Request/response field names of both models. They share the same shape —
 * verified on the fal.ai API pages 2026-08-08:
 *   https://fal.ai/models/fal-ai/bytedance/omnihuman/api
 *   https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/standard/api
 * Kept in one place so a change on fal's side is a one-line fix here.
 */
export const LIPSYNC_FIELDS = {
  /** Input: public https URL of the avatar picture (JPEG / PNG / WebP). */
  imageUrl: "image_url",
  /** Input: public https URL of the speech track (MP3 / OGG / WAV / M4A / AAC). */
  audioUrl: "audio_url",
  /** Output: object holding the generated video, with a `url` inside. */
  video: "video",
} as const;

const FAL_QUEUE_BASE = "https://queue.fal.run";

/**
 * Where to ask about a queued job.
 *
 * fal.ai takes the submission at the FULL model path, but serves job status and
 * result under the first two segments only — the owner and the app. With
 * `fal-ai/sadtalker` the two coincide, so this never surfaced; the moment the
 * model became `fal-ai/bytedance/omnihuman` the status URL turned into a 405
 * and every circle failed after being paid for. Измерено в бою 09.08.2026.
 */
export function queueNamespace(model: string): string {
  return model.split("/").slice(0, 2).join("/");
}
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 9 * 60_000; // sync fal endpoints time out at ~5 min, the queue does not

/**
 * Chooses the lip-sync model for a given speech length.
 * An unknown duration (`null`) goes to the model without a cap: a slightly more
 * expensive video beats a refusal from the model.
 */
export function pickLipSyncModel(speechSeconds: number | null): string {
  if (speechSeconds === null || speechSeconds > OMNIHUMAN_MAX_AUDIO_SECONDS) {
    return LIPSYNC_MODEL_LONG;
  }
  return LIPSYNC_MODEL_SHORT;
}

/** Strips the fal key from anything that goes to the log. */
function redactKey(text: string, falApiKey: string): string {
  if (!falApiKey) return text;
  return text.split(falApiKey).join("***");
}

/** Тексты в журнал — по-русски, чтобы причина отказа читалась без перевода. */
function logVideoFailure(reason: string): void {
  console.error(`Видео-кружочек не создан: ${reason}`);
}

/** Reads an error body without ever leaking the key into the log. */
async function safeErrorText(res: { text: () => Promise<string> }, falApiKey: string): Promise<string> {
  try {
    return redactKey((await res.text()).slice(0, 300), falApiKey);
  } catch {
    return "тело ответа прочитать не удалось";
  }
}

/** Extension of a local file, usable as a fal upload filename suffix. */
function uploadName(prefix: string, filePath: string, fallbackExt: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return `${prefix}.${ext || fallbackExt}`;
}

/**
 * Generate a lip-sync talking-head video via the fal.ai queue API.
 * Returns `null` on any failure (callers fall back to a voice message) and
 * always leaves the reason — model and error code — in the log.
 */
export async function generateLipSync(
  text: string,
  voiceConfig: Record<string, unknown>,
  falApiKey: string,
  avatarPath: string,
): Promise<Buffer | null> {
  if (!fs.existsSync(avatarPath)) {
    logVideoFailure(`не найден файл аватара (${path.basename(avatarPath)})`);
    return null;
  }

  let model = LIPSYNC_MODEL_LONG;
  try {
    const audio = await synthesizeSpeech(text, voiceConfig, falApiKey);
    if (!audio || audio.length === 0) {
      logVideoFailure("не удалось синтезировать речь (TTS вернул пустой ответ)");
      return null;
    }

    const speechSeconds = estimateAudioDurationSeconds(audio);
    model = pickLipSyncModel(speechSeconds);
    const lengthNote = speechSeconds === null
      ? "длительность речи определить не удалось"
      : `длительность речи ~${speechSeconds.toFixed(1)} с`;
    console.log(`Видео-кружочек: ${lengthNote}, модель ${model}`);

    const audioExt = (voiceConfig.tts_provider as string) === "minimax" ? "mp3" : "ogg";
    const [audioUrl, imageUrl] = await Promise.all([
      uploadToFal(audio, `speech.${audioExt}`, falApiKey),
      uploadToFal(fs.readFileSync(avatarPath), uploadName("avatar", avatarPath, "png"), falApiKey),
    ]);

    // Submit to the async queue — generation takes minutes
    const submitRes = await fetch(`${FAL_QUEUE_BASE}/${model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${falApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        [LIPSYNC_FIELDS.imageUrl]: imageUrl,
        [LIPSYNC_FIELDS.audioUrl]: audioUrl,
      }),
    });

    if (!submitRes.ok) {
      logVideoFailure(
        `${model} отклонил запрос, код ${submitRes.status}: ${await safeErrorText(submitRes, falApiKey)}`,
      );
      return null;
    }

    const submitData = (await submitRes.json()) as { request_id?: string };
    const requestId = submitData.request_id;
    if (!requestId) {
      logVideoFailure(`${model} не вернул идентификатор задачи`);
      return null;
    }

    const requestUrl = `${FAL_QUEUE_BASE}/${queueNamespace(model)}/requests/${requestId}`;

    // Poll for completion
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let completed = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const statusRes = await fetch(`${requestUrl}/status`, {
        headers: { Authorization: `Key ${falApiKey}`, Accept: "application/json" },
      });
      if (!statusRes.ok) {
        logVideoFailure(
          `${model} не отдал статус задачи, код ${statusRes.status}: ${await safeErrorText(statusRes, falApiKey)}`,
        );
        return null;
      }

      const statusData = (await statusRes.json()) as { status?: string };
      const status = statusData.status ?? "";
      if (status === "COMPLETED") {
        completed = true;
        break;
      }
      if (status === "FAILED") {
        logVideoFailure(`${model} не справился с задачей (статус FAILED)`);
        return null;
      }
    }

    if (!completed) {
      logVideoFailure(`${model} не уложился в ${Math.round(POLL_TIMEOUT_MS / 60_000)} минут`);
      return null;
    }

    const resultRes = await fetch(requestUrl, {
      headers: { Authorization: `Key ${falApiKey}`, Accept: "application/json" },
    });
    if (!resultRes.ok) {
      logVideoFailure(
        `${model} не отдал результат, код ${resultRes.status}: ${await safeErrorText(resultRes, falApiKey)}`,
      );
      return null;
    }

    const result = (await resultRes.json()) as Record<string, unknown>;
    const videoUrl = (result[LIPSYNC_FIELDS.video] as Record<string, unknown> | undefined)?.url as
      | string
      | undefined;
    if (!videoUrl) {
      logVideoFailure(`${model} вернул ответ без ссылки на видео`);
      return null;
    }

    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) {
      logVideoFailure(`не удалось скачать готовое видео (${model}), код ${videoRes.status}`);
      return null;
    }

    return Buffer.from(await videoRes.arrayBuffer());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logVideoFailure(`сбой при обращении к ${model}: ${redactKey(message, falApiKey)}`);
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
