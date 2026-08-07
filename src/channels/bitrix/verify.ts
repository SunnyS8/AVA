import { timingSafeEqual } from "node:crypto";
import type { BitrixEvent } from "./event.js";

/**
 * Checks that an event really came from our portal application.
 *
 * Default is deny. An empty incoming token, or a missing configured token,
 * rejects the event — a blank secret must never mean "verification off".
 * The project "Агент" shipped that bug once; it let anyone on the portal
 * impersonate the owner.
 */
export function verifyEvent(event: BitrixEvent, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  if (!event.applicationToken) return false;

  // The event comes from parsing someone else's request body: the declared
  // string type is a promise, not a guarantee. A crash here would be a denial
  // of service where a plain refusal is what we want.
  if (typeof event.applicationToken !== "string" || typeof expectedToken !== "string") {
    return false;
  }

  const a = Buffer.from(event.applicationToken);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
