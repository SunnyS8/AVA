import type { IncomingMessage, OutgoingMessage } from "../../core/types.js";
import type { MessageHandler } from "../types.js";
import { resolveProfile, type ProfilesConfig, type UserProfile } from "../../core/profiles.js";
import type { RateLimiter } from "../../core/limits.js";
import type { AccessLevel } from "../../core/access.js";

/** What the portal section of the config can hold at any point in the rollout. */
export interface BitrixStartupConfig {
  webhook_url?: string;
  application_token?: string;
  bot_id?: string;
  client_id?: string;
  client_secret?: string;
}

export type BitrixStartupState = "refused" | "awaiting-install" | "no-bot-id" | "ready";

export interface BitrixStartupPlan {
  start: boolean;
  state: BitrixStartupState;
  /** Written to the owner's console, so Russian — and it must say what to do
   *  next, not merely what is missing. */
  message: string;
}

/**
 * Decides whether the Bitrix channel starts, and in what state.
 *
 * It lives here rather than inline in src/index.ts because a guard inside the
 * entry point is a guard no test can reach — and this one has already been
 * wrong once: it demanded `application_token` and `bot_id`, both of which are
 * produced by an install and a registration that only a RUNNING channel can
 * carry out. That deadlock cost a deployment.
 *
 * `installed` reports whether tokens are already on disk; without it a portal
 * that has been installed would still be told to install itself, because the
 * key from the install never lands in the config.
 */
export function planBitrixStartup(
  config: BitrixStartupConfig,
  installed = false,
): BitrixStartupPlan {
  if (!config.webhook_url) {
    return {
      start: false,
      state: "refused",
      message:
        "Канал Битрикс не поднят: не задан webhook_url — из него берётся адрес портала, " +
        "который нужен, чтобы принять установку приложения.",
    };
  }

  const missing = [
    !config.client_id ? "client_id" : null,
    !config.client_secret ? "client_secret" : null,
  ].filter((k): k is string => k !== null);

  if (missing.length > 0) {
    return {
      start: false,
      state: "refused",
      // Named explicitly: without these the channel would work for exactly one
      // hour after the install and then go silent, which reads as a random
      // failure rather than a missing setting.
      message:
        `Канал Битрикс не поднят: не заданы ключи приложения (${missing.join(", ")}). ` +
        "Возьмите их на странице приложения в портале и впишите в раздел bitrix конфига.",
    };
  }

  if (!config.application_token && !installed) {
    return {
      start: true,
      state: "awaiting-install",
      message:
        "Канал Битрикс поднят и ждёт установку приложения. " +
        "Нажмите «Установить» на странице приложения в портале.",
    };
  }

  if (!config.bot_id) {
    return {
      start: true,
      state: "no-bot-id",
      message:
        "Канал Битрикс поднят, приложение установлено, но бот не зарегистрирован: нет bot_id. " +
        "Запустите scripts/register-bitrix-bot.mjs, впишите bot_id в конфиг и перезапустите Аву.",
    };
  }

  return {
    start: true,
    state: "ready",
    message: "Канал Битрикс поднят полностью: приложение установлено, бот зарегистрирован.",
  };
}

export interface BitrixHandlerDeps {
  /** Calls the engine. Profile is passed so the core can adapt its answer;
   *  access is computed here at the channel boundary and carried in. */
  ask: (msg: IncomingMessage, profile: UserProfile, access: AccessLevel) => Promise<OutgoingMessage>;
  profiles: ProfilesConfig | undefined;
  limiter: RateLimiter;
}

/**
 * Turns an incoming portal message into an answer.
 *
 * Profile and limits are applied here, before the engine is asked: the
 * channel stays a dumb pipe, and a refusal costs no model call.
 */
export function buildBitrixHandler(deps: BitrixHandlerDeps): MessageHandler {
  return async (msg: IncomingMessage): Promise<OutgoingMessage> => {
    const profile = resolveProfile(msg.userId, deps.profiles);

    const verdict = deps.limiter.check(profile.userId, profile.unlimited);
    if (!verdict.allowed) {
      const wait = verdict.retryAfterMin ?? 60;
      return {
        text:
          verdict.reason === "per_day_total"
            ? "На сегодня я исчерпала дневной лимит обращений. Напишите, пожалуйста, завтра."
            : `Вы пишете слишком часто. Я снова смогу ответить примерно через ${wait} мин.`,
      };
    }

    // Access is computed from the resolved role, not trusted from the
    // message: only the owner's own portal identity gets "owner", every
    // other role (analyst, marketing, plain employee) is "restricted".
    const access: AccessLevel = profile.role === "owner" ? "owner" : "restricted";
    return deps.ask(msg, profile, access);
  };
}
