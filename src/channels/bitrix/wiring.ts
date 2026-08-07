import type { IncomingMessage, OutgoingMessage } from "../../core/types.js";
import type { MessageHandler } from "../types.js";
import { resolveProfile, type ProfilesConfig, type UserProfile } from "../../core/profiles.js";
import type { RateLimiter } from "../../core/limits.js";

export interface BitrixHandlerDeps {
  /** Calls the engine. Profile is passed so the core can adapt its answer. */
  ask: (msg: IncomingMessage, profile: UserProfile) => Promise<OutgoingMessage>;
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

    return deps.ask(msg, profile);
  };
}
