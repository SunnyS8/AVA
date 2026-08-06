export type Role =
  | "owner"
  | "analyst"
  | "marketing_head"
  | "marketing_specialist"
  | "employee";

export interface ProfilesConfig {
  owner_id?: string;
  analyst_ids: string[];
  marketing_head_ids: string[];
  marketing_specialist_ids: string[];
  voice_ids: string[];
  video_ids: string[];
  modes: Record<string, string>;
  limits: { per_hour: number; per_day_total: number };
}

export interface UserProfile {
  userId: string;
  role: Role;
  /** Conversation mode key; "default" when nothing special is configured. */
  mode: string;
  voice: boolean;
  video: boolean;
  /** Owner only: rate and spend limits do not apply. */
  unlimited: boolean;
}

/**
 * Works out who is asking and what they are entitled to.
 *
 * Default is deny: an unknown user, or a missing config, yields a plain
 * employee with no voice, no video and normal limits. A list that does not
 * mention someone is a list that does not grant them anything.
 */
export function resolveProfile(
  userId: string,
  cfg: ProfilesConfig | undefined,
): UserProfile {
  if (!cfg) {
    return { userId, role: "employee", mode: "default", voice: false, video: false, unlimited: false };
  }

  const role: Role =
    cfg.owner_id === userId ? "owner"
    : cfg.analyst_ids.includes(userId) ? "analyst"
    : cfg.marketing_head_ids.includes(userId) ? "marketing_head"
    : cfg.marketing_specialist_ids.includes(userId) ? "marketing_specialist"
    : "employee";

  return {
    userId,
    role,
    mode: cfg.modes[userId] ?? "default",
    voice: cfg.voice_ids.includes(userId),
    video: cfg.video_ids.includes(userId),
    unlimited: role === "owner",
  };
}
