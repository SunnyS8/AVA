/**
 * Who is on the other side, and what they may reach.
 *
 * The engine is shared by every channel. Before Ava answered anyone but her
 * owner that was harmless; the day the Telegram bot went public, a stranger
 * could have asked her to read ~/.betsy/config.yaml and received every key at
 * once. Access is decided at the channel boundary and carried into the engine.
 */
export type AccessLevel = "owner" | "restricted";

/**
 * Tools a stranger may use. An allow-list, not a deny-list: a tool added
 * tomorrow is unreachable for strangers until someone deliberately puts it
 * here. Forgetting must fail closed.
 */
export const SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "memory",
  "web",
  "browser",
  "image_gen",
  "selfie",
  "video_message",
  "http",
  "skill_search",
]);

export function isToolAllowed(name: string, level: AccessLevel): boolean {
  if (level === "owner") return true;
  return SAFE_TOOL_NAMES.has(name);
}

export function filterTools<T extends { name: string }>(tools: T[], level: AccessLevel): T[] {
  if (level === "owner") return [...tools];
  return tools.filter((t) => isToolAllowed(t.name, level));
}
