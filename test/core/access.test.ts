import { describe, it, expect } from "vitest";
import { isToolAllowed, filterTools, SAFE_TOOL_NAMES } from "../../src/core/access.js";

describe("access levels", () => {
  it("gives the owner everything", () => {
    expect(isToolAllowed("shell", "owner")).toBe(true);
    expect(isToolAllowed("files", "owner")).toBe(true);
    expect(isToolAllowed("ssh", "owner")).toBe(true);
    expect(isToolAllowed("anything_new", "owner")).toBe(true);
  });

  it("denies the dangerous tools to everyone else", () => {
    for (const name of ["shell", "files", "ssh", "npm_install", "self_config", "send_file"]) {
      expect(isToolAllowed(name, "restricted")).toBe(false);
    }
  });

  it("allows conversation tools to everyone", () => {
    for (const name of ["memory", "web", "image_gen", "selfie"]) {
      expect(isToolAllowed(name, "restricted")).toBe(true);
    }
  });

  it("denies an UNKNOWN tool to a restricted caller — default is deny", () => {
    // Новый инструмент, добавленный завтра, не должен стать доступен всем
    // просто потому, что о нём забыли.
    expect(isToolAllowed("brand_new_tool", "restricted")).toBe(false);
    expect(SAFE_TOOL_NAMES.has("brand_new_tool")).toBe(false);
  });

  it("filters a tool list without mutating it", () => {
    const tools = [{ name: "shell" }, { name: "memory" }, { name: "ssh" }];
    const out = filterTools(tools, "restricted");
    expect(out.map((t) => t.name)).toEqual(["memory"]);
    expect(tools).toHaveLength(3);
    expect(filterTools(tools, "owner")).toHaveLength(3);
  });
});
