# Битрикс24 — этап 1: канал и профили. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сотрудник пишет Аве в Битрикс24 и получает ответ; голос, видео и режим общения выдаются по спискам, лимиты частоты работают, к собственнику не применяются.

**Architecture:** Битрикс шлёт событие на публичный HTTPS-адрес (`nginx` → `127.0.0.1:3777`). Канал `src/channels/bitrix/` — только транспорт: разбор события, проверка подлинности, очередь по диалогу, отправка через REST. Логика (кто есть кто, что положено, лимиты) живёт в ядре `src/core/`. Зависимость строго в одну сторону: канал знает ядро, ядро канал — нет.

**Tech Stack:** Node 22, TypeScript, vitest, zod (конфиг), `node:http` (сервер уже есть), REST Битрикса через `fetch`.

## Global Constraints

- Спека: `docs/superpowers/specs/2026-08-06-bitrix-channel-design.md`. Расхождение с ней — ошибка реализации.
- `src/core/*` НЕ импортирует `src/channels/*`. Обратное разрешено.
- Секрет вебхука не покидает `src/channels/bitrix/client.ts` и не попадает ни в описание инструментов, ни в журнал.
- Умолчание — запрет: нет в списке → нет права. Пустой токен события → отказ, а НЕ «проверка отключена».
- Ответ Битриксу — `200` немедленно; работа асинхронно.
- Текст в Битрикс режется до 8000 символов, сохраняя начало и конец.
- Тесты в `test/`, зеркалят `src/`. Импорты — с расширением `.js`.
- Каждая задача заканчивается зелёным `npm test` и коммитом.
- Язык кода и комментариев — английский, как в остальном проекте; тексты для людей — русские.

---

## Файловая структура

| Файл | Ответственность |
|---|---|
| `src/core/profiles.ts` | Кто написал: роль, режим общения, право на голос и видео |
| `src/core/limits.ts` | Счётчик обращений: в час на человека, в сутки на портал |
| `src/channels/bitrix/event.ts` | Разбор тела события Битрикса в типизированный объект |
| `src/channels/bitrix/verify.ts` | Проверка подлинности события |
| `src/channels/bitrix/client.ts` | REST поверх вебхука: отправка, обрезка. Секрет живёт только здесь |
| `src/channels/bitrix/queue.ts` | Последовательная обработка внутри одного диалога |
| `src/channels/bitrix/index.ts` | Канал: связывает разбор, проверку, очередь и отправку |
| `src/core/config.ts` | Разделы `bitrix` и `profiles` в схеме конфига |
| `src/server.ts` | Маршрут `POST /bitrix/` мимо JWT |
| `src/index.ts` | Создание канала при старте |
| `deploy/bitrix-setup.sh` | nginx + Let's Encrypt на сервере |

---

## Task 1: Разделы конфига `bitrix` и `profiles`

**Files:**
- Modify: `c:\Users\User\Desktop\Агент\Ава\src\core\config.ts` (схема `configSchema`, около строки 100)
- Test: `test/core/config.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: типы `BetsyConfig["bitrix"]` и `BetsyConfig["profiles"]`, используются задачами 2, 3, 6, 10

- [ ] **Step 1: Написать падающий тест**

Добавить в `test/core/config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseConfig } from "../../src/core/config.js";

describe("bitrix and profiles config", () => {
  it("accepts a bitrix section", () => {
    const cfg = parseConfig({
      agent: { name: "Ава" },
      bitrix: { webhook_url: "https://p.bitrix24.ru/rest/1/abc/", application_token: "tok" },
    });
    expect(cfg.bitrix?.webhook_url).toContain("/rest/");
    expect(cfg.bitrix?.application_token).toBe("tok");
  });

  it("fills profile defaults so missing lists mean 'nobody'", () => {
    const cfg = parseConfig({ agent: { name: "Ава" }, profiles: {} });
    expect(cfg.profiles?.voice_ids).toEqual([]);
    expect(cfg.profiles?.video_ids).toEqual([]);
    expect(cfg.profiles?.limits.per_hour).toBe(15);
    expect(cfg.profiles?.limits.per_day_total).toBe(300);
  });

  it("works without either section", () => {
    const cfg = parseConfig({ agent: { name: "Ава" } });
    expect(cfg.bitrix).toBeUndefined();
    expect(cfg.profiles).toBeUndefined();
  });
});
```

Если `parseConfig` в `src/core/config.ts` не экспортируется, экспортировать существующую функцию разбора (та, что зовёт `configSchema.parse`) под этим именем. Не создавать вторую — использовать имеющуюся.

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npm test -- test/core/config.test.ts`
Expected: FAIL — `cfg.bitrix` не проходит схему либо `parseConfig` не экспортирован.

- [ ] **Step 3: Добавить разделы в схему**

В `src/core/config.ts`, внутри `configSchema`, рядом с `telegram`:

```typescript
  bitrix: z.object({
    webhook_url: z.string(),
    application_token: z.string(),
    bot_id: z.string().optional(),
  }).optional(),

  profiles: z.object({
    owner_id: z.string().optional(),
    analyst_ids: z.array(z.string()).default([]),
    marketing_head_ids: z.array(z.string()).default([]),
    marketing_specialist_ids: z.array(z.string()).default([]),
    voice_ids: z.array(z.string()).default([]),
    video_ids: z.array(z.string()).default([]),
    modes: z.record(z.string(), z.string()).default({}),
    limits: z.object({
      per_hour: z.number().default(15),
      per_day_total: z.number().default(300),
    }).default({}),
  }).optional(),
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- test/core/config.test.ts`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add src/core/config.ts test/core/config.test.ts
git commit -m "feat(config): разделы bitrix и profiles"
```

---

## Task 2: Профили пользователей

**Files:**
- Create: `src/core/profiles.ts`
- Test: `test/core/profiles.test.ts`

**Interfaces:**
- Consumes: `BetsyConfig["profiles"]` из задачи 1
- Produces:
  - `type Role = "owner" | "analyst" | "marketing_head" | "marketing_specialist" | "employee"`
  - `interface UserProfile { userId: string; role: Role; mode: string; voice: boolean; video: boolean; unlimited: boolean }`
  - `function resolveProfile(userId: string, cfg: ProfilesConfig | undefined): UserProfile`

- [ ] **Step 1: Написать падающий тест**

Создать `test/core/profiles.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveProfile } from "../../src/core/profiles.js";

const cfg = {
  owner_id: "1",
  analyst_ids: ["6"],
  marketing_head_ids: ["20"],
  marketing_specialist_ids: ["21", "22"],
  voice_ids: ["1", "6"],
  video_ids: ["1"],
  modes: { "1": "personal", "6": "analyst" },
  limits: { per_hour: 15, per_day_total: 300 },
};

describe("resolveProfile", () => {
  it("recognises the owner and lifts his limits", () => {
    const p = resolveProfile("1", cfg);
    expect(p.role).toBe("owner");
    expect(p.unlimited).toBe(true);
    expect(p.mode).toBe("personal");
  });

  it("recognises analyst, marketing head and specialist", () => {
    expect(resolveProfile("6", cfg).role).toBe("analyst");
    expect(resolveProfile("20", cfg).role).toBe("marketing_head");
    expect(resolveProfile("22", cfg).role).toBe("marketing_specialist");
  });

  it("treats an unknown user as a plain employee with limits", () => {
    const p = resolveProfile("999", cfg);
    expect(p.role).toBe("employee");
    expect(p.unlimited).toBe(false);
    expect(p.mode).toBe("default");
  });

  it("denies voice and video to anyone not on the list", () => {
    expect(resolveProfile("999", cfg).voice).toBe(false);
    expect(resolveProfile("999", cfg).video).toBe(false);
    expect(resolveProfile("6", cfg).voice).toBe(true);
    expect(resolveProfile("6", cfg).video).toBe(false);
  });

  it("denies everything when there is no config at all", () => {
    const p = resolveProfile("1", undefined);
    expect(p.role).toBe("employee");
    expect(p.voice).toBe(false);
    expect(p.video).toBe(false);
    expect(p.unlimited).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npm test -- test/core/profiles.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/profiles.js'`

- [ ] **Step 3: Реализовать**

Создать `src/core/profiles.ts`:

```typescript
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
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- test/core/profiles.test.ts`
Expected: PASS — 5 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/core/profiles.ts test/core/profiles.test.ts
git commit -m "feat(core): профили пользователей, умолчание — запрет"
```

---

## Task 3: Лимиты частоты

**Files:**
- Create: `src/core/limits.ts`
- Test: `test/core/limits.test.ts`

**Interfaces:**
- Consumes: `UserProfile.unlimited` из задачи 2
- Produces:
  - `class RateLimiter { constructor(perHour: number, perDayTotal: number, now?: () => number); check(userId: string, unlimited: boolean): LimitVerdict }`
  - `interface LimitVerdict { allowed: boolean; reason?: "per_hour" | "per_day_total"; retryAfterMin?: number }`

Часы берутся через внедряемую функцию `now`, чтобы тест не зависел от настоящего времени.

- [ ] **Step 1: Написать падающий тест**

Создать `test/core/limits.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { RateLimiter } from "../../src/core/limits.js";

describe("RateLimiter", () => {
  it("allows up to the hourly cap and blocks the next one", () => {
    let t = 0;
    const rl = new RateLimiter(15, 300, () => t);
    for (let i = 0; i < 15; i++) {
      expect(rl.check("7", false).allowed).toBe(true);
    }
    const v = rl.check("7", false);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("per_hour");
    expect(v.retryAfterMin).toBeGreaterThan(0);
  });

  it("forgets the hour once it has passed", () => {
    let t = 0;
    const rl = new RateLimiter(2, 300, () => t);
    rl.check("7", false);
    rl.check("7", false);
    expect(rl.check("7", false).allowed).toBe(false);
    t = 61 * 60 * 1000;
    expect(rl.check("7", false).allowed).toBe(true);
  });

  it("counts the portal-wide daily cap across users", () => {
    let t = 0;
    const rl = new RateLimiter(1000, 3, () => t);
    expect(rl.check("a", false).allowed).toBe(true);
    expect(rl.check("b", false).allowed).toBe(true);
    expect(rl.check("c", false).allowed).toBe(true);
    const v = rl.check("d", false);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("per_day_total");
  });

  it("never limits the owner and does not count him against the portal cap", () => {
    let t = 0;
    const rl = new RateLimiter(1, 1, () => t);
    for (let i = 0; i < 50; i++) {
      expect(rl.check("1", true).allowed).toBe(true);
    }
    expect(rl.check("other", false).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npm test -- test/core/limits.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/core/limits.ts`:

```typescript
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface LimitVerdict {
  allowed: boolean;
  reason?: "per_hour" | "per_day_total";
  /** Minutes to wait before the next attempt makes sense. */
  retryAfterMin?: number;
}

/**
 * Counts requests per user and across the whole portal.
 *
 * The owner is exempt: his calls are neither blocked nor counted towards the
 * portal cap, so a busy day of his cannot lock the staff out.
 */
export class RateLimiter {
  private perUser = new Map<string, number[]>();
  private portal: number[] = [];

  constructor(
    private perHour: number,
    private perDayTotal: number,
    private now: () => number = () => Date.now(),
  ) {}

  check(userId: string, unlimited: boolean): LimitVerdict {
    if (unlimited) return { allowed: true };

    const t = this.now();

    this.portal = this.portal.filter((ts) => t - ts < DAY_MS);
    if (this.portal.length >= this.perDayTotal) {
      return { allowed: false, reason: "per_day_total", retryAfterMin: 60 };
    }

    const mine = (this.perUser.get(userId) ?? []).filter((ts) => t - ts < HOUR_MS);
    if (mine.length >= this.perHour) {
      const oldest = mine[0];
      const waitMs = HOUR_MS - (t - oldest);
      this.perUser.set(userId, mine);
      return {
        allowed: false,
        reason: "per_hour",
        retryAfterMin: Math.max(1, Math.ceil(waitMs / 60000)),
      };
    }

    mine.push(t);
    this.perUser.set(userId, mine);
    this.portal.push(t);
    return { allowed: true };
  }
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- test/core/limits.test.ts`
Expected: PASS — 4 теста

- [ ] **Step 5: Коммит**

```bash
git add src/core/limits.ts test/core/limits.test.ts
git commit -m "feat(core): лимиты частоты, собственник не ограничен"
```

---

## Task 4: Разбор события Битрикса

**Files:**
- Create: `src/channels/bitrix/event.ts`
- Test: `test/channels/bitrix-event.test.ts`

Битрикс шлёт `application/x-www-form-urlencoded` с ключами в скобках:
`event=ONIMBOTMESSAGEADD&data[PARAMS][DIALOG_ID]=chat42&auth[application_token]=tok`.

**Interfaces:**
- Consumes: ничего
- Produces:
  - `interface BitrixEvent { event: string; dialogId: string; fromUserId: string; text: string; applicationToken: string; fromBot: boolean }`
  - `function parseBitrixEvent(body: string): BitrixEvent | null`

- [ ] **Step 1: Написать падающий тест**

Создать `test/channels/bitrix-event.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseBitrixEvent } from "../../src/channels/bitrix/event.js";

const body = [
  "event=ONIMBOTMESSAGEADD",
  "data%5BPARAMS%5D%5BDIALOG_ID%5D=chat42",
  "data%5BPARAMS%5D%5BFROM_USER_ID%5D=17",
  "data%5BPARAMS%5D%5BMESSAGE%5D=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82",
  "auth%5Bapplication_token%5D=tok123",
].join("&");

describe("parseBitrixEvent", () => {
  it("pulls dialog, author, text and token out of a real payload", () => {
    const e = parseBitrixEvent(body)!;
    expect(e.event).toBe("ONIMBOTMESSAGEADD");
    expect(e.dialogId).toBe("chat42");
    expect(e.fromUserId).toBe("17");
    expect(e.text).toBe("Привет");
    expect(e.applicationToken).toBe("tok123");
    expect(e.authorId).toBe("");
  });

  it("reports the author id as sent, judging nothing", () => {
    const human = parseBitrixEvent(body + "&data%5BPARAMS%5D%5BAUTHOR_ID%5D=17")!;
    expect(human.authorId).toBe("17");
    const zero = parseBitrixEvent(body + "&data%5BPARAMS%5D%5BAUTHOR_ID%5D=0")!;
    expect(zero.authorId).toBe("0");
  });

  it("returns null on a body that is not an event", () => {
    expect(parseBitrixEvent("")).toBeNull();
    expect(parseBitrixEvent("hello=world")).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npm test -- test/channels/bitrix-event.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/channels/bitrix/event.ts`:

```typescript
export interface BitrixEvent {
  event: string;
  dialogId: string;
  fromUserId: string;
  text: string;
  applicationToken: string;
  /**
   * Raw AUTHOR_ID as sent by the portal. The parser reports it and judges
   * nothing: deciding "this is our own bot talking" needs the bot's id, which
   * only the channel knows. Guessing here would be an unverified assumption
   * guarding the one thing that must not fail — the anti-loop check.
   */
  authorId: string;
}

/**
 * Parses a Bitrix event body.
 *
 * Bitrix posts form-encoded data with bracketed keys, e.g.
 * `data[PARAMS][DIALOG_ID]`. Returns null when the body is not an event —
 * the caller answers 400 rather than guessing.
 */
export function parseBitrixEvent(body: string): BitrixEvent | null {
  if (!body) return null;

  const params = new URLSearchParams(body);
  const event = params.get("event");
  if (!event) return null;

  const p = (key: string) => params.get(`data[PARAMS][${key}]`) ?? "";

  return {
    event,
    dialogId: p("DIALOG_ID"),
    fromUserId: p("FROM_USER_ID"),
    text: p("MESSAGE"),
    applicationToken: params.get("auth[application_token]") ?? "",
    authorId: p("AUTHOR_ID"),
  };
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- test/channels/bitrix-event.test.ts`
Expected: PASS — 3 теста

- [ ] **Step 5: Коммит**

```bash
git add src/channels/bitrix/event.ts test/channels/bitrix-event.test.ts
git commit -m "feat(bitrix): разбор события портала"
```

---

## Task 5: Проверка подлинности события

**Files:**
- Create: `src/channels/bitrix/verify.ts`
- Test: `test/channels/bitrix-verify.test.ts`

**Interfaces:**
- Consumes: `BitrixEvent` из задачи 4
- Produces: `function verifyEvent(event: BitrixEvent, expectedToken: string | undefined): boolean`

- [ ] **Step 1: Написать падающий тест**

Создать `test/channels/bitrix-verify.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { verifyEvent } from "../../src/channels/bitrix/verify.js";
import type { BitrixEvent } from "../../src/channels/bitrix/event.js";

const ev = (token: string): BitrixEvent => ({
  event: "ONIMBOTMESSAGEADD",
  dialogId: "chat1",
  fromUserId: "7",
  text: "hi",
  applicationToken: token,
  fromBot: false,
});

describe("verifyEvent", () => {
  it("accepts a matching token", () => {
    expect(verifyEvent(ev("good"), "good")).toBe(true);
  });

  it("rejects a forged token", () => {
    expect(verifyEvent(ev("bad"), "good")).toBe(false);
  });

  it("rejects an empty token instead of treating it as 'checks off'", () => {
    expect(verifyEvent(ev(""), "good")).toBe(false);
  });

  it("rejects everything when no token is configured", () => {
    expect(verifyEvent(ev("anything"), undefined)).toBe(false);
    expect(verifyEvent(ev("anything"), "")).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npm test -- test/channels/bitrix-verify.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/channels/bitrix/verify.ts`:

```typescript
import { timingSafeEqual } from "node:crypto";
import type { BitrixEvent } from "./event.js";

/**
 * Checks that an event really came from our portal application.
 *
 * Default is deny. An empty incoming token, or a missing configured token,
 * rejects the event — a blank secret must never mean "verification off".
 * The project "Агент" shipped that bug once; it let anyone on the portal
 * impersonate the owner.
 */
export function verifyEvent(event: BitrixEvent, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  if (!event.applicationToken) return false;

  const a = Buffer.from(event.applicationToken);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- test/channels/bitrix-verify.test.ts`
Expected: PASS — 4 теста

- [ ] **Step 5: Коммит**

```bash
git add src/channels/bitrix/verify.ts test/channels/bitrix-verify.test.ts
git commit -m "feat(bitrix): проверка подлинности, пустой токен не отключает её"
```

---

## Task 6: REST-клиент Битрикса

**Files:**
- Create: `src/channels/bitrix/client.ts`
- Test: `test/channels/bitrix-client.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces:
  - `function clip(text: string, limit?: number): string`
  - `class BitrixClient { constructor(webhookUrl: string, fetchImpl?: typeof fetch); sendMessage(dialogId: string, text: string): Promise<void> }`

- [ ] **Step 1: Написать падающий тест**

Создать `test/channels/bitrix-client.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { BitrixClient, clip } from "../../src/channels/bitrix/client.js";

describe("clip", () => {
  it("leaves a short text alone", () => {
    expect(clip("hello", 100)).toBe("hello");
  });

  it("keeps the head and the tail of a long text", () => {
    const long = "A".repeat(50) + "MIDDLE" + "B".repeat(50);
    const out = clip(long, 40);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("B")).toBe(true);
    expect(out).toContain("…");
  });
});

describe("BitrixClient", () => {
  it("sends as the bot, not as the webhook owner", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "{}" });
    const c = new BitrixClient("https://p.bitrix24.ru/rest/6/secret/", "42", fetchMock as unknown as typeof fetch);
    await c.sendMessage("chat42", "привет");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // imbot.message.add — сообщение от имени бота. im.message.add отправил бы
    // его от имени владельца вебхука, и сотрудники увидели бы живого человека.
    expect(url).toBe("https://p.bitrix24.ru/rest/6/secret/imbot.message.add.json");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent.BOT_ID).toBe("42");
    expect(sent.DIALOG_ID).toBe("chat42");
    expect(sent.MESSAGE).toBe("привет");
  });

  it("clips an over-long message before sending", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "{}" });
    const c = new BitrixClient("https://p.bitrix24.ru/rest/6/secret/", "42", fetchMock as unknown as typeof fetch);
    await c.sendMessage("chat1", "x".repeat(9000));
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.MESSAGE.length).toBeLessThanOrEqual(8001);
  });

  it("throws with a message that does NOT contain the webhook secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    const c = new BitrixClient("https://p.bitrix24.ru/rest/6/supersecret/", "42", fetchMock as unknown as typeof fetch);
    await expect(c.sendMessage("chat1", "hi")).rejects.toThrow(/500/);
    await expect(c.sendMessage("chat1", "hi")).rejects.not.toThrow(/supersecret/);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npm test -- test/channels/bitrix-client.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/channels/bitrix/client.ts`:

```typescript
export const MAX_MESSAGE_LEN = 8000;

/**
 * Trims the middle out of a long text, keeping the head and the tail.
 * Bitrix cuts long messages itself, and the tail is usually the conclusion —
 * losing it is worse than losing the middle.
 */
export function clip(text: string, limit: number = MAX_MESSAGE_LEN): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 2);
  const tail = limit - head - 1;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * Bitrix REST over an incoming webhook.
 *
 * The webhook URL is a secret: it never leaves this class and never appears
 * in an error message or a log line.
 */
export class BitrixClient {
  constructor(
    private webhookUrl: string,
    private botId: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async sendMessage(dialogId: string, text: string): Promise<void> {
    const base = this.webhookUrl.endsWith("/") ? this.webhookUrl : `${this.webhookUrl}/`;
    const res = await this.fetchImpl(`${base}imbot.message.add.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ BOT_ID: this.botId, DIALOG_ID: dialogId, MESSAGE: clip(text) }),
    });

    if (!res.ok) {
      // Deliberately no URL in the message — it carries the secret.
      throw new Error(`Bitrix imbot.message.add failed: HTTP ${res.status}`);
    }
  }
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- test/channels/bitrix-client.test.ts`
Expected: PASS — 5 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/channels/bitrix/client.ts test/channels/bitrix-client.test.ts
git commit -m "feat(bitrix): REST-клиент, секрет не покидает модуль"
```

---

## Task 7: Очередь по диалогу

**Files:**
- Create: `src/channels/bitrix/queue.ts`
- Test: `test/channels/bitrix-queue.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `class DialogQueue { enqueue(dialogId: string, job: () => Promise<void>): void; idle(): Promise<void> }`

- [ ] **Step 1: Написать падающий тест**

Создать `test/channels/bitrix-queue.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DialogQueue } from "../../src/channels/bitrix/queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("DialogQueue", () => {
  it("keeps order inside one dialog", async () => {
    const q = new DialogQueue();
    const order: string[] = [];
    q.enqueue("a", async () => { await sleep(20); order.push("first"); });
    q.enqueue("a", async () => { order.push("second"); });
    await q.idle();
    expect(order).toEqual(["first", "second"]);
  });

  it("runs different dialogs in parallel", async () => {
    const q = new DialogQueue();
    const order: string[] = [];
    q.enqueue("a", async () => { await sleep(30); order.push("slow"); });
    q.enqueue("b", async () => { order.push("fast"); });
    await q.idle();
    expect(order).toEqual(["fast", "slow"]);
  });

  it("a failing job does not block the next one", async () => {
    const q = new DialogQueue();
    const order: string[] = [];
    q.enqueue("a", async () => { throw new Error("boom"); });
    q.enqueue("a", async () => { order.push("after"); });
    await q.idle();
    expect(order).toEqual(["after"]);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npm test -- test/channels/bitrix-queue.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/channels/bitrix/queue.ts`:

```typescript
/**
 * Serialises work within one dialog, runs different dialogs in parallel.
 *
 * Two answers to the same chat computed at once would arrive in the wrong
 * order and read as a mess. A job that throws is logged by its own caller and
 * must not block the rest of the queue.
 */
export class DialogQueue {
  private chains = new Map<string, Promise<void>>();

  enqueue(dialogId: string, job: () => Promise<void>): void {
    const previous = this.chains.get(dialogId) ?? Promise.resolve();
    const next = previous.then(() => job()).catch(() => undefined);
    this.chains.set(dialogId, next);
  }

  /** Resolves once every queued job has settled. Used by tests. */
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- test/channels/bitrix-queue.test.ts`
Expected: PASS — 3 теста

- [ ] **Step 5: Коммит**

```bash
git add src/channels/bitrix/queue.ts test/channels/bitrix-queue.test.ts
git commit -m "feat(bitrix): очередь по диалогу"
```

---

## Task 8: Канал Битрикса

**Files:**
- Create: `src/channels/bitrix/index.ts`
- Test: `test/channels/bitrix.test.ts`

**Interfaces:**
- Consumes: `parseBitrixEvent` (задача 4), `verifyEvent` (задача 5), `BitrixClient` (задача 6), `DialogQueue` (задача 7), `Channel`/`MessageHandler` из `src/channels/types.ts`
- Produces:
  - `class BitrixChannel implements Channel`
  - `handleWebhook(body: string): { status: number }` — синхронный ответ Битриксу, работа уходит в очередь

- [ ] **Step 1: Написать падающий тест**

Создать `test/channels/bitrix.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { BitrixChannel } from "../../src/channels/bitrix/index.js";

function body(opts: { token?: string; text?: string; author?: string } = {}) {
  const p = new URLSearchParams();
  p.set("event", "ONIMBOTMESSAGEADD");
  p.set("data[PARAMS][DIALOG_ID]", "chat42");
  p.set("data[PARAMS][FROM_USER_ID]", "17");
  p.set("data[PARAMS][MESSAGE]", opts.text ?? "привет");
  p.set("auth[application_token]", opts.token ?? "tok");
  if (opts.author) p.set("data[PARAMS][AUTHOR_ID]", opts.author);
  return p.toString();
}

function makeChannel() {
  const sent: Array<{ dialogId: string; text: string }> = [];
  const client = { sendMessage: async (dialogId: string, text: string) => { sent.push({ dialogId, text }); } };
  const ch = new BitrixChannel({ applicationToken: "tok", botId: "42", client: client as never });
  return { ch, sent };
}

describe("BitrixChannel", () => {
  it("has the channel name and required config", () => {
    const { ch } = makeChannel();
    expect(ch.name).toBe("bitrix");
    expect(ch.requiredConfig).toContain("webhook_url");
    expect(ch.requiredConfig).toContain("application_token");
  });

  it("answers 200 immediately and replies into the same dialog", async () => {
    const { ch, sent } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));

    const res = ch.handleWebhook(body());
    expect(res.status).toBe(200);

    await ch.idle();
    expect(sent).toEqual([{ dialogId: "chat42", text: "ответ" }]);
  });

  it("passes the author id through as userId", async () => {
    const { ch } = makeChannel();
    const seen = vi.fn().mockResolvedValue({ text: "ok" });
    ch.onMessage(seen);
    ch.handleWebhook(body());
    await ch.idle();
    expect(seen.mock.calls[0][0]).toMatchObject({ channelName: "bitrix", userId: "17", text: "привет" });
  });

  it("rejects a forged token with 401 and answers nothing", async () => {
    const { ch, sent } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    const res = ch.handleWebhook(body({ token: "forged" }));
    expect(res.status).toBe(401);
    await ch.idle();
    expect(sent).toEqual([]);
  });

  it("never answers its own bot — the anti-loop guard", async () => {
    const { ch, sent } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    // botId канала — "42": сообщение с таким автором написали мы сами
    const res = ch.handleWebhook(body({ author: "42" }));
    expect(res.status).toBe(200);
    await ch.idle();
    expect(sent).toEqual([]);
  });

  it("ignores portal system messages", async () => {
    const { ch, sent } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    const res = ch.handleWebhook(body({ author: "0" }));
    expect(res.status).toBe(200);
    await ch.idle();
    expect(sent).toEqual([]);
  });

  it("does answer a human whose author id is neither the bot nor zero", async () => {
    const { ch, sent } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    ch.handleWebhook(body({ author: "17" }));
    await ch.idle();
    expect(sent).toEqual([{ dialogId: "chat42", text: "ответ" }]);
  });

  it("answers 400 on a body that is not an event", () => {
    const { ch } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    expect(ch.handleWebhook("garbage=1").status).toBe(400);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npm test -- test/channels/bitrix.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/channels/bitrix/index.ts`:

```typescript
import type { Channel, MessageHandler } from "../types.js";
import type { OutgoingMessage } from "../../core/types.js";
import { parseBitrixEvent } from "./event.js";
import { verifyEvent } from "./verify.js";
import { BitrixClient } from "./client.js";
import { DialogQueue } from "./queue.js";

export interface BitrixChannelOptions {
  applicationToken?: string;
  botId?: string;
  client?: BitrixClient;
}

/**
 * Bitrix24 channel.
 *
 * Transport only: parse, verify, enqueue, send. Every decision about who may
 * ask what lives in the core — this class must stay dumb enough to reason
 * about at a glance.
 */
export class BitrixChannel implements Channel {
  name = "bitrix";
  requiredConfig = ["webhook_url", "application_token", "bot_id"];

  private handler: MessageHandler | null = null;
  private queue = new DialogQueue();
  private client: BitrixClient | null;
  private applicationToken: string | undefined;
  private botId: string | undefined;

  constructor(options: BitrixChannelOptions = {}) {
    this.client = options.client ?? null;
    this.applicationToken = options.applicationToken;
    this.botId = options.botId;
  }

  async start(config: Record<string, string>): Promise<void> {
    if (!this.handler) {
      throw new Error("BitrixChannel: call onMessage() before start()");
    }
    this.applicationToken = this.applicationToken ?? config.application_token;
    this.botId = this.botId ?? config.bot_id;
    this.client = this.client ?? new BitrixClient(config.webhook_url, config.bot_id);
  }

  async stop(): Promise<void> {
    await this.queue.idle();
  }

  async send(dialogId: string, message: OutgoingMessage): Promise<void> {
    await this.client?.sendMessage(dialogId, message.text);
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Resolves once queued work has settled. Used by tests and by stop(). */
  async idle(): Promise<void> {
    await this.queue.idle();
  }

  /**
   * Handles one webhook body. Returns the status to answer with — the answer
   * goes out immediately, the thinking happens in the queue. Bitrix retries
   * events we are slow to acknowledge.
   */
  handleWebhook(body: string): { status: number } {
    const event = parseBitrixEvent(body);
    if (!event) return { status: 400 };

    if (!verifyEvent(event, this.applicationToken)) {
      console.warn("bitrix: event rejected, token mismatch");
      return { status: 401 };
    }

    // Anti-loop. We compare against the id we registered the bot with, not a
    // guessed constant: this guard is the only thing standing between us and a
    // bot answering itself forever, and it must not rest on an assumption.
    if (this.botId && (event.authorId === this.botId || event.fromUserId === this.botId)) {
      return { status: 200 };
    }
    // AUTHOR_ID=0 marks portal system messages — nothing to answer there either.
    if (event.authorId === "0") return { status: 200 };
    if (!event.text) return { status: 200 };

    const handler = this.handler;
    const client = this.client;
    if (!handler || !client) return { status: 200 };

    this.queue.enqueue(event.dialogId, async () => {
      try {
        const answer = await handler({
          channelName: "bitrix",
          userId: event.fromUserId,
          text: event.text,
          timestamp: Date.now(),
          metadata: { dialogId: event.dialogId },
        });
        await client.sendMessage(event.dialogId, answer.text);
      } catch (err) {
        console.error("bitrix: failed to answer", (err as Error).message);
        await client
          .sendMessage(event.dialogId, "Не смогла ответить, попробуйте позже.")
          .catch(() => undefined);
      }
    });

    return { status: 200 };
  }
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- test/channels/bitrix.test.ts`
Expected: PASS — 6 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/channels/bitrix/index.ts test/channels/bitrix.test.ts
git commit -m "feat(bitrix): канал — 200 сразу, ответ в тот же диалог"
```

---

## Task 9: Маршрут `/bitrix/` в сервере

**Files:**
- Modify: `src/server.ts` (функция `createRequestHandler`, строки 195–227)
- Modify: `src/server.ts` (интерфейс `ServerOptions`, около строки 19)
- Test: `test/server.test.ts`

Маршрут обязан идти ДО ветки `/api/` и НЕ требовать JWT: Битрикс токена не знает.

**Interfaces:**
- Consumes: `BitrixChannel.handleWebhook` из задачи 8
- Produces: `ServerOptions.bitrix?: { handleWebhook(body: string): { status: number } }`

- [ ] **Step 1: Написать падающий тест**

Добавить в `test/server.test.ts`:

ВАЖНО: `createServer` слушает порт САМ (`src/server.ts:747`) — повторный
`server.listen()` уронит тест с `ERR_SERVER_ALREADY_LISTEN`. Порт берётся из
`handle.server.address()` сразу. Файл `test/server.test.ts` уже глушит конфиг
через `BETSY_CONFIG_PATH` в `beforeAll` и закрывает сервер в `afterEach` —
переиспользуйте существующие `handle` и хуки, новых не заводите.

К импортам файла добавить `vi`:

```typescript
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
```

Добавить блок:

```typescript
describe("POST /bitrix/", () => {
  it("passes the body to the channel and answers its status without a token", async () => {
    const handleWebhook = vi.fn().mockReturnValue({ status: 200 });
    handle = createServer({ port: 0, passwordHash: "irrelevant", bitrix: { handleWebhook } });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/bitrix/`, {
      method: "POST",
      body: "event=ONIMBOTMESSAGEADD",
    });

    expect(res.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledWith("event=ONIMBOTMESSAGEADD");
  });

  it("answers 404 when no bitrix channel is wired up", async () => {
    handle = createServer({ port: 0 });
    const addr = handle.server.address() as { port: number };
    const res = await fetch(`http://localhost:${addr.port}/bitrix/`, { method: "POST", body: "x" });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npm test -- test/server.test.ts`
Expected: FAIL — путь `/bitrix/` уходит в `serveStatic` и отдаёт не тот код.

- [ ] **Step 3: Реализовать**

В `src/server.ts` в интерфейс `ServerOptions` добавить:

```typescript
  /** Bitrix webhook sink. Wired in src/index.ts when the channel is enabled. */
  bitrix?: { handleWebhook(body: string): { status: number } };
```

В `createRequestHandler`, сразу после разбора `url` (строка 209) и ДО ветки `/api/`:

```typescript
    if (url.pathname.startsWith("/bitrix/")) {
      // No JWT here on purpose: Bitrix cannot present one. Authenticity is
      // proven by the application token inside the event body.
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      if (!options.bitrix) {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const { status } = options.bitrix!.handleWebhook(body);
        res.writeHead(status);
        res.end();
      });
      return;
    }
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- test/server.test.ts`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(server): маршрут /bitrix/ мимо JWT"
```

---

## Task 10: Подключение канала при старте

**Files:**
- Modify: `src/index.ts` (рядом с созданием Telegram, строки 199–252)
- Test: `test/channels/bitrix-wiring.test.ts`

Профиль и лимиты применяются ЗДЕСЬ, до вызова движка: канал остаётся глупым.

**Interfaces:**
- Consumes: `BitrixChannel` (8), `resolveProfile` (2), `RateLimiter` (3), конфиг (1)
- Produces: `function buildBitrixHandler(deps): MessageHandler` — вынесенная функция, чтобы её можно было проверить без запуска сервера

- [ ] **Step 1: Написать падающий тест**

Создать `test/channels/bitrix-wiring.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildBitrixHandler } from "../../src/channels/bitrix/wiring.js";
import { RateLimiter } from "../../src/core/limits.js";

const profiles = {
  owner_id: "1",
  analyst_ids: [], marketing_head_ids: [], marketing_specialist_ids: [],
  voice_ids: [], video_ids: [], modes: {},
  limits: { per_hour: 2, per_day_total: 100 },
};

const msg = (userId: string) => ({
  channelName: "bitrix", userId, text: "вопрос", timestamp: 0,
});

describe("buildBitrixHandler", () => {
  it("asks the engine and returns its answer", async () => {
    const ask = vi.fn().mockResolvedValue({ text: "ответ" });
    const h = buildBitrixHandler({ ask, profiles, limiter: new RateLimiter(2, 100, () => 0) });
    expect(await h(msg("7"))).toEqual({ text: "ответ" });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("refuses politely once the limit is spent and stops asking the engine", async () => {
    const ask = vi.fn().mockResolvedValue({ text: "ответ" });
    const h = buildBitrixHandler({ ask, profiles, limiter: new RateLimiter(2, 100, () => 0) });
    await h(msg("7"));
    await h(msg("7"));
    const third = await h(msg("7"));
    expect(third.text).toMatch(/слишком часто|позже/i);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("never limits the owner", async () => {
    const ask = vi.fn().mockResolvedValue({ text: "ответ" });
    const h = buildBitrixHandler({ ask, profiles, limiter: new RateLimiter(1, 1, () => 0) });
    for (let i = 0; i < 5; i++) {
      expect((await h(msg("1"))).text).toBe("ответ");
    }
    expect(ask).toHaveBeenCalledTimes(5);
  });

  it("passes the caller profile to the engine", async () => {
    const ask = vi.fn().mockResolvedValue({ text: "ответ" });
    const h = buildBitrixHandler({ ask, profiles, limiter: new RateLimiter(9, 99, () => 0) });
    await h(msg("1"));
    expect(ask.mock.calls[0][1]).toMatchObject({ role: "owner", unlimited: true });
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npm test -- test/channels/bitrix-wiring.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/channels/bitrix/wiring.ts`:

```typescript
import type { IncomingMessage, OutgoingMessage } from "../../core/types.js";
import type { MessageHandler } from "../types.js";
import { resolveProfile, type ProfilesConfig, type UserProfile } from "../../core/profiles.js";
import type { RateLimiter } from "../../core/limits.js";

export interface BitrixHandlerDeps {
  /** Calls the engine. Profile is passed so the core can adapt its answer. */
  ask: (msg: IncomingMessage, profile: UserProfile) => Promise<OutgoingMessage>;
  profiles: ProfilesConfig | undefined;
  limiter: RateLimiter;
}

/**
 * Turns an incoming portal message into an answer.
 *
 * Profile and limits are applied here, before the engine is asked: the
 * channel stays a dumb pipe, and a refusal costs no model call.
 */
export function buildBitrixHandler(deps: BitrixHandlerDeps): MessageHandler {
  return async (msg: IncomingMessage): Promise<OutgoingMessage> => {
    const profile = resolveProfile(msg.userId, deps.profiles);

    const verdict = deps.limiter.check(profile.userId, profile.unlimited);
    if (!verdict.allowed) {
      const wait = verdict.retryAfterMin ?? 60;
      return {
        text:
          verdict.reason === "per_day_total"
            ? "На сегодня я исчерпала дневной лимит обращений. Напишите, пожалуйста, завтра."
            : `Вы пишете слишком часто. Я снова смогу ответить примерно через ${wait} мин.`,
      };
    }

    return deps.ask(msg, profile);
  };
}
```

В `src/index.ts` после блока Telegram (после строки 252) добавить:

```typescript
  let bitrix: BitrixChannel | null = null;
  // bot_id появляется только после регистрации бота (задача 12): без него
  // отправлять от имени Авы нечем, поэтому канал молча не поднимается.
  if (config.bitrix?.webhook_url && config.bitrix?.application_token && config.bitrix?.bot_id) {
    const limiter = new RateLimiter(
      config.profiles?.limits.per_hour ?? 15,
      config.profiles?.limits.per_day_total ?? 300,
    );
    bitrix = new BitrixChannel();
    bitrix.onMessage(
      buildBitrixHandler({
        ask: async (msg) => {
          if (!engine) return { text: "Я сейчас не могу ответить — модель не подключена." };
          // Same order as the Telegram wiring (src/index.ts:214): the scheduler
          // must know where to answer before the engine starts thinking.
          scheduler.setMessageContext(msg.channelName, msg.userId, engine.getHistory(msg.userId) ?? []);
          return engine.process(msg);
        },
        profiles: config.profiles,
        limiter,
      }),
    );
    await bitrix.start({
      webhook_url: config.bitrix.webhook_url,
      application_token: config.bitrix.application_token,
      bot_id: config.bitrix.bot_id,
    });
    channels.set("bitrix", bitrix);
    console.log("✅ Канал Битрикс запущен");
  }
```

Импорты в начало `src/index.ts`:

```typescript
import { BitrixChannel } from "./channels/bitrix/index.js";
import { buildBitrixHandler } from "./channels/bitrix/wiring.js";
import { RateLimiter } from "./core/limits.js";
```

Передать канал в сервер там, где вызывается `createServer({ port, engine: ... })` (строка 196): добавить `bitrix: bitrix ?? undefined`. Блок Битрикса должен идти ДО вызова `createServer`.

- [ ] **Step 4: Запустить тесты и типы**

Run: `npm test -- test/channels/bitrix-wiring.test.ts && npm run typecheck`
Expected: PASS, typecheck без ошибок

- [ ] **Step 5: Коммит**

```bash
git add src/channels/bitrix/wiring.ts src/index.ts test/channels/bitrix-wiring.test.ts
git commit -m "feat(bitrix): профиль и лимиты до вызова модели"
```

---

## Task 11: Публичный HTTPS на сервере

**Files:**
- Create: `deploy/bitrix-setup.sh`
- Create: `deploy/nginx-ava.conf`

Скрипт запускается на сервере от root и идемпотентен. Повторяет схему, работающую у проекта «Агент».

**Interfaces:**
- Consumes: служба `ava` на `127.0.0.1:3777` (уже развёрнута)
- Produces: `https://83.222.26.241.sslip.io/bitrix/` — адрес обработчика событий для портала

- [ ] **Step 1: Создать конфиг nginx**

Создать `deploy/nginx-ava.conf`:

```nginx
# Публичный HTTPS-фронт для событий Битрикса.
# Включается ТОЛЬКО после выпуска сертификата: иначе nginx -t падает на
# отсутствующих файлах (грабли проекта «Агент»).

upstream ava_app {
    server 127.0.0.1:3777;
}

server {
    listen 80;
    server_name 83.222.26.241.sslip.io;

    location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}
```

Создать `deploy/nginx-ava-public.conf`:

```nginx
server {
    listen 443 ssl;
    server_name 83.222.26.241.sslip.io;

    ssl_certificate     /etc/letsencrypt/live/83.222.26.241.sslip.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/83.222.26.241.sslip.io/privkey.pem;

    location /bitrix/ {
        proxy_pass http://ava_app;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
    location = /health {
        proxy_pass http://ava_app;
    }
    location / {
        return 404;  # панель управления наружу НЕ выставляем
    }
}
```

- [ ] **Step 2: Создать скрипт установки**

Создать `deploy/bitrix-setup.sh`:

```bash
#!/usr/bin/env bash
# Поднимает публичный HTTPS для событий Битрикса. Запускать от root НА СЕРВЕРЕ.
# Идемпотентен: повторный запуск обновляет конфиги и перечитывает nginx.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DOMAIN=83.222.26.241.sslip.io

say() { echo ">> $*"; }
[ "$(id -u)" = "0" ] || { echo "нужен root"; exit 1; }

say "Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -yqq nginx certbot >/dev/null

say "Брандмауэр: открываю 80 и 443"
ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null

say "Конфиг nginx (только :80, до сертификата)"
install -d /var/www/acme
install -m 644 "$HERE/nginx-ava.conf" /etc/nginx/sites-available/ava
ln -sf /etc/nginx/sites-available/ava /etc/nginx/sites-enabled/ava
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

say "Сертификат Let's Encrypt"
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  certbot certonly --webroot -w /var/www/acme -d "$DOMAIN" \
    --non-interactive --agree-tos --register-unsafely-without-email
else
  say "сертификат уже есть — не перевыпускаю"
fi

say "Включаю публичный блок :443"
install -m 644 "$HERE/nginx-ava-public.conf" /etc/nginx/sites-available/ava-public
ln -sf /etc/nginx/sites-available/ava-public /etc/nginx/sites-enabled/ava-public
nginx -t
systemctl reload nginx

say "Проверка снаружи"
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/bitrix/" -X POST -d 'x=1' || true)
echo "POST https://$DOMAIN/bitrix/ -> HTTP $code (ожидаем 400 или 401: события нет или токен не тот)"
code_root=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/" || true)
echo "GET  https://$DOMAIN/          -> HTTP $code_root (ожидаем 404: панель закрыта)"

say "Готово. Адрес обработчика: https://$DOMAIN/bitrix/"
```

- [ ] **Step 3: Проверить синтаксис скрипта локально**

Run: `bash -n deploy/bitrix-setup.sh && echo OK`
Expected: `OK`

Убедиться, что файлы в LF: `.gitattributes` уже задаёт `*.sh text eol=lf`.

- [ ] **Step 4: Выполнить на сервере и проверить живьём**

Загрузить `deploy/` на сервер и запустить `bash deploy/bitrix-setup.sh`.
Ожидаемо в конце: `POST … -> HTTP 401` (событие без верного токена отвергнуто) и `GET … -> HTTP 404` (панель закрыта).

Если `401` не появился, а пришёл `404` — маршрут `/bitrix/` не подключён: проверить, что в конфиге Авы заполнены `bitrix.webhook_url` и `bitrix.application_token`, и что служба перезапущена.

- [ ] **Step 5: Коммит**

```bash
git add deploy/bitrix-setup.sh deploy/nginx-ava.conf deploy/nginx-ava-public.conf
git commit -m "feat(deploy): публичный HTTPS для событий Битрикса"
```

---

## Task 12: Регистрация бота в портале

**Files:**
- Create: `scripts/register-bitrix-bot.mjs`

Выполняется ОДИН раз, ПОСЛЕ задачи 11: `imbot.register` требует рабочие
публичные URL обработчиков, до поднятия HTTPS вызов бессмысленен.

Замер портала `importks.bitrix24.ru` (06.08.2026): чат-ботов 2.0
(`imbot.v2.*`) НЕТ, доступен только классический API — 37 методов, включая
`imbot.register`. Опрос событий (`event.offline.get`) для ботов не работает:
обработчики обязательны. Права вебхука: `department, im, imbot, user`.

**Interfaces:**
- Consumes: вебхук из `~/.betsy/config.yaml` (`bitrix.webhook_url`)
- Produces: `BOT_ID`, который вписывается в `bitrix.bot_id`

- [ ] **Step 1: Написать скрипт регистрации**

Создать `scripts/register-bitrix-bot.mjs`:

```javascript
// Регистрирует Аву как чат-бота портала. Запускать ОДИН раз, после того как
// поднят публичный HTTPS (deploy/bitrix-setup.sh).
//
//   node scripts/register-bitrix-bot.mjs <webhook_url>
//
// Вебхук передаётся аргументом и НЕ хранится в скрипте.

const webhook = process.argv[2];
if (!webhook) {
  console.error("нужен URL вебхука аргументом");
  process.exit(1);
}
const base = webhook.endsWith("/") ? webhook : webhook + "/";
const HANDLER = "https://83.222.26.241.sslip.io/bitrix/";

const body = {
  CODE: "ava",
  TYPE: "B",
  EVENT_MESSAGE_ADD: HANDLER,
  EVENT_WELCOME_MESSAGE: HANDLER,
  EVENT_BOT_DELETE: HANDLER,
  PROPERTIES: {
    NAME: "Ава",
    COLOR: "AQUA",
    EMAIL: "",
    PERSONAL_BIRTHDAY: "",
    WORK_POSITION: "AI-компаньон",
  },
};

const res = await fetch(`${base}imbot.register.json`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const data = await res.json();

if (!res.ok || data.error) {
  console.error(`регистрация не прошла: HTTP ${res.status} ${data.error ?? ""} ${data.error_description ?? ""}`);
  process.exit(1);
}

console.log("BOT_ID =", data.result);
console.log("Впишите его в ~/.betsy/config.yaml как bitrix.bot_id и перезапустите службу:");
console.log("  systemctl restart ava");
```

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check scripts/register-bitrix-bot.mjs && echo OK`
Expected: `OK`

- [ ] **Step 3: Выполнить регистрацию**

Выполнить на машине владельца, подставив вебхук из
`Агент\Ава\вебхух битрикс ава.txt`:

```bash
node scripts/register-bitrix-bot.mjs "<webhook_url>"
```

Expected: строка `BOT_ID = <число>`.

Если пришло `ERROR_METHOD_NOT_FOUND` — у вебхука нет права `imbot`.
Если `WRONG_HANDLER_URL` — публичный адрес не отвечает: вернуться к задаче 11.

- [ ] **Step 4: Вписать BOT_ID и перезапустить**

В `~/.betsy/config.yaml` на сервере, раздел `bitrix`:

```yaml
bitrix:
  webhook_url: "…"
  application_token: "…"
  bot_id: "<полученное число>"
```

Затем `systemctl restart ava` и проверить журнал:
`journalctl -u ava -n 20` — ожидается строка `✅ Канал Битрикс запущен`.

- [ ] **Step 5: Коммит**

```bash
git add scripts/register-bitrix-bot.mjs
git commit -m "feat(bitrix): скрипт регистрации бота в портале"
```

---

## Сдача этапа

- [ ] `npm run typecheck` — 0
- [ ] `npm test` — все зелёные, новых падений нет
- [ ] `npm run build:all` — 0
- [ ] Пересобрать пакет и обновить сервер (`deploy/install.sh`)
- [ ] Вебхук с правом `imbot` вписан в `~/.betsy/config.yaml` (уже создан владельцем 06.08.2026, права `department, im, imbot, user`)
- [ ] Бот зарегистрирован (задача 12), `bot_id` вписан, служба перезапущена
- [ ] **Живая проверка:** сотрудник пишет Аве в портале и получает ответ; человек не из списка `voice_ids` голосового ответа не получает
- [ ] Отметить результат в `docs/superpowers/plans/` и обновить спеку, если живая проверка что-то опровергла

## Чего в этом этапе НЕТ

Переносится в этапы 2–4 по спеке: база знаний по продукту и согласование правок, правило «цифры учёта → к Игорю» со страховкой на выходе, личный контур собственника и его изоляция, личный помощник, отчёты аналитику и маркетингу, выдача голоса и видео как медиа-ответов (здесь только ПРАВО на них в профиле).
