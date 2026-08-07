# Доступ по роли: инструменты и личное владельца. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Посторонний собеседник не может ни выполнить команду на сервере, ни прочитать файл, ни узнать личное о собственнике — независимо от того, каким каналом он пришёл.

**Architecture:** Уровень доступа вычисляется на границе (в обвязке канала) и передаётся в движок явным параметром. Движок фильтрует по нему набор инструментов — дважды: при показе модели и при исполнении. Системная инструкция и поиск по базе знаний для чужого собеседника собираются без личного владельца.

**Tech Stack:** Node 22, TypeScript, vitest.

## Global Constraints

- **Умолчание — запрет.** Параметр доступа отсутствует → уровень `restricted`. Ни один вызывающий не получает полный доступ молчанием.
- Проверка на исполнении обязательна: модель может назвать инструмент, которого ей не показывали.
- `src/core/*` не импортирует `src/channels/*`.
- Тесты в `test/`, зеркалят `src/`, импорты с `.js`.
- Код и комментарии по-английски, тексты для людей по-русски.
- База: **931 passed | 84 skipped | 0 failed**, typecheck 0.
- Каждая задача: тест → падение → код → зелёное → коммит.

---

## Почему это делается

Замер 07.08.2026: `ShellTool`, `FilesTool` (любой абсолютный путь), `sshTool`,
`npmInstallTool` регистрируются безусловно; `requiresConfirmation` объявлен, но
нигде не проверяется. Пока Ава отвечала только владельцу, это было безопасно.
В день, когда включили публичный режим Telegram, любой написавший мог попросить
`~/.betsy/config.yaml` — то есть все ключи разом. Публичный режим выключен как
временная мера; этот план снимает причину.

Второе: `owner.name`, `owner.address_as`, `owner.facts` попадают в системную
инструкцию КАЖДОГО диалога, а поиск по базе знаний — общий. Чужой собеседник
получает личное владельца, потому что движок не знает, кто перед ним.

---

## Task 1: Модуль уровней доступа

**Files:**
- Create: `src/core/access.ts`
- Test: `test/core/access.test.ts`

**Interfaces:**
- Consumes: `Tool` из `src/core/tools/types.js`
- Produces:
  - `type AccessLevel = "owner" | "restricted"`
  - `const SAFE_TOOL_NAMES: ReadonlySet<string>`
  - `function isToolAllowed(name: string, level: AccessLevel): boolean`
  - `function filterTools<T extends { name: string }>(tools: T[], level: AccessLevel): T[]`

- [ ] **Step 1: Написать падающий тест**

Создать `test/core/access.test.ts`:

```typescript
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
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm run test -- test/core/access.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать**

Создать `src/core/access.ts`:

```typescript
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
```

Имена инструментов сверь с реальными: открой `src/core/tools/` и убедись, что
`name` каждого класса совпадает с тем, что здесь перечислено. Если какое-то имя
отличается — используй настоящее и скажи мне, какое поправил.

- [ ] **Step 4: Запустить тесты**

Run: `npm run test -- test/core/access.test.ts`
Expected: PASS — 5 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/core/access.ts test/core/access.test.ts
git commit -m "feat(core): уровни доступа, умолчание — запрет"
```

---

## Task 2: Движок фильтрует инструменты и прячет личное владельца

**Files:**
- Modify: `src/core/engine.ts` (сигнатура `process`, показ инструментов модели, `executeTool`, сборка системной инструкции)
- Modify: `src/core/prompt.ts` (блок про владельца — по флагу)
- Test: `test/core/engine-access.test.ts`

**Interfaces:**
- Consumes: `AccessLevel`, `filterTools`, `isToolAllowed` из задачи 1
- Produces: `Engine.process(msg, onProgress?, access?: AccessLevel)` — при отсутствии параметра уровень `restricted`

- [ ] **Step 1: Написать падающий тест**

Создать `test/core/engine-access.test.ts`. Возьми за образец существующий
`test/core/engine.test.ts` — там уже есть заглушки LLM и реестра инструментов,
переиспользуй их подход, свой не изобретай.

Тест обязан проверить четыре вещи:

1. При `access = "restricted"` в определения инструментов, переданные модели,
   НЕ попадают `shell`, `files`, `ssh`, `npm_install`.
2. При `access = "owner"` они попадают.
3. Если модель ВСЁ РАВНО вызовет `shell` при `restricted` — исполнения не
   происходит, возвращается отказ. Это главный тест задачи: показ и исполнение
   защищаются раздельно.
4. Вызов `process(msg)` без третьего параметра ведёт себя как `restricted`.

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm run test -- test/core/engine-access.test.ts`

- [ ] **Step 3: Реализовать**

В `src/core/engine.ts`:

- добавить третий параметр `access: AccessLevel = "restricted"` в `process`;
- там, где реестр отдаёт определения инструментов модели, пропустить их через
  `filterTools(..., access)`;
- в `executeTool` первым делом проверить `isToolAllowed(name, access)`; если
  нет — вернуть результат с ошибкой и НЕ вызывать `tool.execute`. Текст для
  человека по-русски, например «Этот инструмент мне недоступен в этом разговоре»;
- пробросить `access` в сборку системной инструкции;
- при `restricted` НЕ выполнять `searchKnowledge` — общая база знаний
  собственника не должна попадать чужому.

В `src/core/prompt.ts` — добавить в `buildSystemPrompt` параметр, управляющий
блоком «Твой человек» (`owner.name`, `addressAs`, `facts`). При `restricted`
блок не добавляется. Существующие вызывающие не должны сломаться: параметр
необязательный, по умолчанию блок включён — но `engine.ts` обязан передавать
его явно.

- [ ] **Step 4: Запустить тесты**

Run: `npm run test`
Expected: 931 + новые, 0 failed. Плюс `npm run typecheck` — 0.

- [ ] **Step 5: Коммит**

```bash
git add src/core/engine.ts src/core/prompt.ts test/core/engine-access.test.ts
git commit -m "feat(core): движок фильтрует инструменты и прячет личное владельца"
```

---

## Task 3: Каналы вычисляют уровень доступа

**Files:**
- Modify: `src/channels/bitrix/wiring.ts`
- Modify: `src/index.ts` (обвязка Telegram, планировщик)
- Modify: `src/channels/connect-notify.ts`
- Modify: `src/server.ts` (чат панели)
- Test: `test/channels/bitrix-wiring.test.ts` (дополнить)

**Interfaces:**
- Consumes: `AccessLevel` из задачи 1, `UserProfile` из `src/core/profiles.js`
- Produces: каждый вызов `engine.process` передаёт уровень явно

- [ ] **Step 1: Написать падающий тест**

Дополнить `test/channels/bitrix-wiring.test.ts`: обвязка Битрикса передаёт
`"owner"` для профиля с ролью `owner` и `"restricted"` для рядового сотрудника.

- [ ] **Step 2: Запустить, убедиться что падает**

- [ ] **Step 3: Реализовать**

- **Битрикс** (`wiring.ts`): `profile.role === "owner" ? "owner" : "restricted"`.
- **Telegram** (`src/index.ts`): сравнить `msg.userId` с `config.telegram.owner_id`.
  Совпало — `"owner"`, иначе `"restricted"`. Это то, что позволит вернуть
  публичный режим: посторонний в Telegram получит те же ограничения, что и
  сотрудник в портале.
- **Панель** (`src/server.ts`): `"owner"` — вход в неё уже за паролем.
- **Планировщик** (`src/index.ts`) и **уведомления о сервисах**
  (`connect-notify.ts`): `"restricted"`. Осознанно: задание могло быть
  создано кем угодно, а определять создателя задним числом сейчас нечем.
  Записать это комментарием в коде.

- [ ] **Step 4: Запустить тесты**

Run: `npm run test` и `npm run typecheck`

- [ ] **Step 5: Коммит**

```bash
git add -A
git commit -m "feat(channels): уровень доступа вычисляется на границе"
```

---

## Task 4: Переключатели инструментов в панели начинают работать

**Files:**
- Modify: `src/index.ts` (регистрация инструментов)
- Test: `test/core/tools-config.test.ts`

Сейчас `security.tools` (`shell`, `ssh`, `browser`, `npm_install`) читается
ТОЛЬКО страницей настроек. На сервере переключатели не влияют ни на что —
выключатель, который ничего не выключает, хуже отсутствующего: он создаёт
ложное чувство, что защита настроена.

**Interfaces:**
- Consumes: `config.security?.tools` из схемы конфига
- Produces: инструмент не регистрируется вовсе, если выключен в конфиге

- [ ] **Step 1: Написать падающий тест**

Вынеси решение «какие инструменты регистрировать» в чистую функцию, чтобы её
можно было проверить без запуска `main()`. Создать
`src/core/tools-enabled.ts` с функцией вида
`isToolEnabled(name: string, cfg: SecurityToolsConfig | undefined): boolean`
и тест на неё: умолчания совпадают с теми, что показывает панель
(`shell` — да, `ssh` — нет, `browser` — да, `npm_install` — да), а явное
`false` в конфиге выключает.

- [ ] **Step 2: Запустить, убедиться что падает**

- [ ] **Step 3: Реализовать**

В `src/index.ts` при регистрации оборачивать соответствующие вызовы проверкой.
Учти: `ssh` по умолчанию ВЫКЛЮЧЕН согласно панели — значит после этой правки
он перестанет регистрироваться, пока не включён явно. Это правильно и
осознанно; отметь в отчёте.

- [ ] **Step 4: Запустить тесты**

- [ ] **Step 5: Коммит**

```bash
git add -A
git commit -m "feat(core): переключатели инструментов из конфига наконец работают"
```

---

## Сдача этапа

- [ ] `npm run typecheck` — 0
- [ ] `npm run test` — все зелёные
- [ ] `npm run build:all` — 0
- [ ] Финальное ревью ветки
- [ ] Развернуть на сервере, проверить журнал
- [ ] **Живая проверка:** написать Аве в Telegram НЕ с аккаунта владельца и
      попросить прочитать файл — обязан прийти отказ, а не содержимое
- [ ] После этого можно вернуть публичный режим Telegram и включать Битрикс
