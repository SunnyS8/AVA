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
//
// Deliberately absent: "memory". It is a thin wrapper over the same global
// knowledge table that this module keeps away from strangers — list returns
// everything, and delete/save let a stranger damage the owner's memory. It
// can return once the knowledge base is partitioned per user.
export const SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web",
  "image_gen",
  "selfie",
  "video_message",
  "skill_search",
]);

/**
 * Who may spend money on generated media.
 *
 * `profiles.video_ids` / `voice_ids` existed in the config and were computed
 * into every UserProfile — and read by nobody. The config looked like it
 * restricted access while all 116 portal employees could order video. A
 * permission flag nothing enforces is worse than none: it invites trust it has
 * not earned.
 */
export interface MediaPermissions {
  video: boolean;
  voice: boolean;
}

/**
 * Tools billed per call, each gated by its own permission rather than by the
 * general access level. A fifteen-second circle costs about two dollars, so
 * these stay closed to everyone who is not named.
 */
export const MEDIA_TOOLS: Readonly<Record<string, keyof MediaPermissions>> = {
  video_message: "video",
  voice_message: "voice",
};

export function isToolAllowed(
  name: string,
  level: AccessLevel,
  media?: MediaPermissions,
): boolean {
  const needs = MEDIA_TOOLS[name];
  if (needs) {
    // Deny by default, and the owner level is no exception: the list decides
    // for everyone. Missing permissions (channel forgot to pass them, config
    // lost the list) close the door instead of opening it — the failure that
    // costs nothing is the one to prefer when the other one costs money.
    return media?.[needs] === true;
  }
  if (level === "owner") return true;
  return SAFE_TOOL_NAMES.has(name);
}

export function filterTools<T extends { name: string }>(
  tools: T[],
  level: AccessLevel,
  media?: MediaPermissions,
): T[] {
  return tools.filter((t) => isToolAllowed(t.name, level, media));
}
