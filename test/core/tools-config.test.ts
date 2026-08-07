import { describe, it, expect } from "vitest";
import { isToolEnabled } from "../../src/core/tools-enabled.js";

describe("isToolEnabled", () => {
  it("matches the settings panel's defaults when security.tools is absent", () => {
    // Same defaults as SecurityTab in src/ui/pages/Settings.tsx: shell/browser/
    // npm_install default on, ssh defaults off.
    expect(isToolEnabled("shell", undefined)).toBe(true);
    expect(isToolEnabled("ssh", undefined)).toBe(false);
    expect(isToolEnabled("browser", undefined)).toBe(true);
    expect(isToolEnabled("npm_install", undefined)).toBe(true);
  });

  it("matches the settings panel's defaults when the section exists but is empty", () => {
    expect(isToolEnabled("shell", {})).toBe(true);
    expect(isToolEnabled("ssh", {})).toBe(false);
    expect(isToolEnabled("browser", {})).toBe(true);
    expect(isToolEnabled("npm_install", {})).toBe(true);
  });

  it("an explicit false disables a tool that defaults to on", () => {
    expect(isToolEnabled("shell", { shell: false })).toBe(false);
    expect(isToolEnabled("browser", { browser: false })).toBe(false);
    expect(isToolEnabled("npm_install", { npm_install: false })).toBe(false);
  });

  it("an explicit true enables a tool that defaults to off", () => {
    expect(isToolEnabled("ssh", { ssh: true })).toBe(true);
  });

  it("treats a tool outside the security.tools list as always enabled", () => {
    expect(isToolEnabled("memory", { shell: false, ssh: false, browser: false, npm_install: false })).toBe(true);
    expect(isToolEnabled("scheduler", undefined)).toBe(true);
  });

  it("works with no security section at all in the config", () => {
    // cfg is `config.security?.tools`, so a config with no `security` key
    // still resolves to `undefined` here — defaults must hold.
    const cfg: { shell?: boolean; ssh?: boolean; browser?: boolean; npm_install?: boolean } | undefined =
      undefined;
    expect(isToolEnabled("shell", cfg)).toBe(true);
    expect(isToolEnabled("ssh", cfg)).toBe(false);
  });
});
