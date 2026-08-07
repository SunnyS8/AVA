import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/core/prompt.js";

describe("buildSystemPrompt", () => {
  it("includes the agent name", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("Бетси");
  });

  it("includes personality tone", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      personality: { tone: "friendly" },
    });
    expect(prompt).toContain("Тон: friendly");
  });

  it("includes personality response style", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      personality: { responseStyle: "concise" },
    });
    expect(prompt).toContain("Стиль ответов: concise");
  });

  it("includes custom instructions", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      personality: { customInstructions: "Ты милая и игривая." },
    });
    expect(prompt).toContain("Ты милая и игривая.");
  });

  it("includes settings menu capability", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("/settings");
    expect(prompt).toContain("Стиль ответов");
    expect(prompt).toContain("Напоминания");
  });

  it("includes tools list", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("shell");
    expect(prompt).toContain("browser");
    expect(prompt).toContain("self_config");
  });

  it("includes owner info when provided and access is owner", () => {
    // access defaults to "restricted" (fail-closed) — this test is about the
    // owner-info block itself, so it passes "owner" explicitly.
    const prompt = buildSystemPrompt(
      {
        name: "Бетси",
        owner: {
          name: "Константин",
          facts: ["день рождения 4 мая", "жена Аня", "дочь Лиза"],
        },
      },
      undefined,
      undefined,
      undefined,
      "owner",
    );
    expect(prompt).toContain("Константин");
    expect(prompt).toContain("день рождения 4 мая");
    expect(prompt).toContain("жена Аня");
  });

  it("includes user message when provided", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" }, "Привет");
    expect(prompt).toContain("Привет");
  });

  it("responds in Russian by default", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("русском языке");
  });

  it("mentions the terminal only when shell is in the available tools list", () => {
    const withShell = buildSystemPrompt(
      { name: "Бетси" }, undefined, undefined, undefined, "owner", ["shell", "memory"],
    );
    expect(withShell).toContain("shell");

    const withoutShell = buildSystemPrompt(
      { name: "Бетси" }, undefined, undefined, undefined, "owner", ["memory"],
    );
    expect(withoutShell).not.toContain("shell");
  });

  it("mentions ssh only when ssh is in the available tools list", () => {
    const withSsh = buildSystemPrompt(
      { name: "Бетси" }, undefined, undefined, undefined, "owner", ["ssh", "memory"],
    );
    expect(withSsh).toContain("ssh");

    const withoutSsh = buildSystemPrompt(
      { name: "Бетси" }, undefined, undefined, undefined, "owner", ["memory"],
    );
    expect(withoutSsh).not.toContain("ssh");
  });

  it("does not promise a terminal or ssh to a restricted stranger limited to safe tools", () => {
    // Mirrors what engine.ts actually passes: filterTools(tools, "restricted")
    // — only SAFE_TOOL_NAMES from access.ts survive, shell/ssh never do.
    const prompt = buildSystemPrompt(
      { name: "Бетси" }, undefined, undefined, undefined, "restricted", ["web", "selfie", "image_gen"],
    );
    expect(prompt).not.toContain("shell");
    expect(prompt).not.toContain("ssh");
  });
});
