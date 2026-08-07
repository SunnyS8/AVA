import type { Channel } from "./types.js";
import type { ServiceDefinition } from "../services/catalog.js";
import type { OnConnectedCallback } from "../core/tools/connect-service.js";

/** Minimal shape used from Engine — avoids importing the full class just for typing. */
export interface EngineLike {
  process(msg: {
    channelName: string;
    userId: string;
    text: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ text: string; mediaUrl?: string; mediaPath?: string }>;
}

export interface ConnectNotifyDeps {
  channels: Map<string, Channel>;
  /** Lazy lookup — `engine` in src/index.ts is assigned after tools are
   * registered, so a plain value would freeze at `null` forever. */
  getEngine: () => EngineLike | null;
}

/**
 * Builds the ConnectServiceTool `onConnected` callback.
 *
 * Notifies the user ONLY on the channel their connect request came from.
 * Fanning out to every registered channel (the old behaviour) is wrong the
 * moment a second channel exists: a Telegram numeric chat id and a Bitrix
 * dialog id are different address spaces, so `channel.send(userId, …)`
 * against the wrong channel either delivers nowhere or lands in someone
 * else's dialog. If the originating channel cannot be determined, skip and
 * log — never guess by broadcasting.
 */
export function buildConnectNotifyHandler(deps: ConnectNotifyDeps): OnConnectedCallback {
  return async (userId: string, service: ServiceDefinition, scopes: string[], channelName: string) => {
    const channel = deps.channels.get(channelName);
    if (!channel) {
      console.error(`❌ onConnected: канал "${channelName}" не найден, уведомление о подключении ${service.name} пропущено`);
      return;
    }

    try {
      const scopeLabels = scopes.map((s) => service.scopes[s] ?? s).join(", ");
      await channel.send(userId, {
        text: `✅ ${service.name} подключён! Доступны: ${scopeLabels}. Проверяю подключение...`,
      });

      // Ask engine to verify the connection
      const engine = deps.getEngine();
      if (engine) {
        const result = await engine.process({
          channelName: channel.name,
          userId,
          text: `Сервис ${service.name} только что подключился (${scopeLabels}). Сделай один тестовый запрос к API чтобы проверить что всё работает, и коротко расскажи результат.`,
          timestamp: Date.now(),
          metadata: { serviceConnected: true },
        });
        await channel.send(userId, result);
      }
    } catch (err) {
      console.error(`❌ onConnected notification error:`, err);
    }
  };
}
