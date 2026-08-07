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
    for (const name of ["web", "image_gen", "selfie"]) {
      expect(isToolAllowed(name, "restricted")).toBe(true);
    }
  });

  it("keeps a stranger out of the owner's knowledge base", () => {
    // memory читает и пишет ту же общую таблицу, что закрыта в движке:
    // list отдаёт всё, delete портит память владельца
    expect(isToolAllowed("memory", "restricted")).toBe(false);
    expect(isToolAllowed("memory", "owner")).toBe(true);
  });

  it("keeps a stranger away from arbitrary network destinations", () => {
    // http и browser принимают адрес от собеседника без проверки: через них
    // достаётся панель Авы на 127.0.0.1:3777 и внутренняя сеть сервера
    expect(isToolAllowed("http", "restricted")).toBe(false);
    expect(isToolAllowed("browser", "restricted")).toBe(false);
    expect(isToolAllowed("http", "owner")).toBe(true);
  });

  it("denies an UNKNOWN tool to a restricted caller — default is deny", () => {
    // Новый инструмент, добавленный завтра, не должен стать доступен всем
    // просто потому, что о нём забыли.
    expect(isToolAllowed("brand_new_tool", "restricted")).toBe(false);
    expect(SAFE_TOOL_NAMES.has("brand_new_tool")).toBe(false);
  });

  it("filters a tool list without mutating it", () => {
    const tools = [{ name: "shell" }, { name: "web" }, { name: "ssh" }];
    const out = filterTools(tools, "restricted");
    expect(out.map((t) => t.name)).toEqual(["web"]);
    expect(tools).toHaveLength(3);
    expect(filterTools(tools, "owner")).toHaveLength(3);
  });
});
