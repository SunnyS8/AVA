/**
 * Whether a tool is allowed to even exist for this run — the config-side
 * kill switch from the settings panel (`security.tools`), not the
 * per-caller access check in `access.ts`.
 *
 * Before this module, the panel's toggles were read-only theatre: they
 * rendered in Settings.tsx but src/index.ts registered every tool
 * unconditionally, regardless of what the owner had switched off. A switch
 * that shows "SSH: off" while SSH still answers is worse than no switch —
 * it tells the owner a door is locked that never was.
 *
 * Defaults here MUST match Settings.tsx (`SecurityTab`'s initial `tools`
 * state) exactly — that panel is what the owner reads as ground truth.
 */

/** Mirrors `config.security?.tools` from the config schema (src/core/config.ts). */
export interface SecurityToolsConfig {
  shell?: boolean;
  ssh?: boolean;
  browser?: boolean;
  npm_install?: boolean;
}

// Keep in sync with src/ui/pages/Settings.tsx (SecurityTab's `useState` for
// `tools`) and the zod defaults in src/core/config.ts (`security.tools`).
const TOOL_DEFAULTS: Readonly<Record<keyof SecurityToolsConfig, boolean>> = {
  shell: true,
  ssh: false,
  browser: true,
  npm_install: true,
};

/**
 * Is the named tool enabled? Only the four tools listed in
 * `security.tools` are governed by this config section — anything else
 * (memory, web, scheduler, ...) is outside its scope and stays enabled,
 * because the section manages a specific list, not "everything".
 */
export function isToolEnabled(name: string, cfg: SecurityToolsConfig | undefined): boolean {
  if (!isManagedTool(name)) return true;
  const configured = cfg?.[name];
  return configured ?? TOOL_DEFAULTS[name];
}

function isManagedTool(name: string): name is keyof SecurityToolsConfig {
  return Object.prototype.hasOwnProperty.call(TOOL_DEFAULTS, name);
}
