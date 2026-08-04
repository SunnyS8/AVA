import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { Tool, ToolResult } from "./types.js";
import { generateLipSync } from "../../channels/telegram/video.js";

export interface VideoMessageToolConfig {
  /** TTS / voice settings (tts_provider, voice_id, etc.). */
  voiceConfig: Record<string, unknown>;
  /** fal.ai API key for lip-sync generation. */
  falApiKey: string;
  /** Local path to the avatar image (or a resolver returning one). */
  avatarPath: string | (() => string);
}

/**
 * Generates a talking-head video (video circle) from text.
 * The LLM calls this when the user asks for a video note / кружочек.
 */
export class VideoMessageTool implements Tool {
  name = "video_message";
  description =
    "Отправить видео-кружочек (видеосообщение, где губы Авы двигаются в такт речи, lip-sync). " +
    "Используй когда просят прислать видео-кружок, видео-сообщение, кружочек, «отправь видео», " +
    "или когда уместно ответить движущимся видео. Обязательно текст озвучивается в видео.";

  parameters = [
    { name: "text", type: "string", description: "Текст, который Ава озвучивает в видео-кружочке", required: true },
  ];

  private config: VideoMessageToolConfig;

  constructor(config: VideoMessageToolConfig) {
    this.config = config;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const text = String(params.text ?? "").trim();
    if (!text) {
      return { success: false, output: "Не указан текст для видео", error: "Missing text" };
    }

    if (!this.config.falApiKey) {
      return {
        success: false,
        output: "Для видео-кружочков нужен ключ fal.ai. Попроси пользователя получить ключ на https://fal.ai/dashboard/keys.",
      };
    }

    const avatarPath = typeof this.config.avatarPath === "function"
      ? this.config.avatarPath()
      : this.config.avatarPath;
    if (!avatarPath || !fs.existsSync(avatarPath)) {
      return {
        success: false,
        output: "Нет аватара для видео. Попроси пользователя отправить фото и написать /setphoto.",
      };
    }

    try {
      const video = await generateLipSync(text, this.config.voiceConfig, this.config.falApiKey, avatarPath);
      if (!video) {
        return {
          success: false,
          output: "Не удалось сгенерировать видео-кружочек (проверь голос/баланс fal.ai).",
        };
      }

      const filePath = path.join(os.tmpdir(), `betsy-video-${Date.now()}.mp4`);
      fs.writeFileSync(filePath, video);
      return { success: true, output: "Видео-кружочек сгенерирован", mediaPath: filePath };
    } catch (err) {
      console.error(`video_message error: ${err instanceof Error ? err.message : err}`);
      return {
        success: false,
        output: "Ошибка генерации видео-кружочка",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}