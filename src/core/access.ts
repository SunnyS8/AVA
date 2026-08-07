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
// Deliberately absent: "http" and "browser". Both take a URL from the caller
// with no host or protocol check, so a stranger could point them at Ava's own
// panel on 127.0.0.1:3777, at cloud metadata, or at anything inside the
// server's network — the same key leak we are closing here, over the network
// instead of the filesystem. They can return once those tools validate the
// target; the pattern already exists in src/multi/agents/tools/fetch-url-tool.ts
// (isBlockedHost / isBlockedUrl).
export const SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "memory",
  "web",
  "image_gen",
  "selfie",
  "video_message",
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
