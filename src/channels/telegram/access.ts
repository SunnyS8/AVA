import type { AccessLevel } from "../../core/access.js";

/**
 * Access level for a Telegram sender.
 *
 * Only the configured owner gets "owner" — everyone else, including a
 * caller writing before an owner has been claimed (`ownerId` still
 * undefined), gets "restricted". Default is deny: an unset owner must not
 * accidentally grant everyone owner tools.
 *
 * Compared as strings on purpose: `ownerId` comes from config as a number
 * (`z.number()`, see src/core/config.ts), `userId` is always a string.
 */
export function computeTelegramAccess(userId: string, ownerId: number | undefined): AccessLevel {
  if (ownerId === undefined || ownerId === null) return "restricted";
  return String(ownerId) === userId ? "owner" : "restricted";
}
