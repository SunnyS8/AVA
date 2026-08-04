# P1 · Distribution Shell — Design

**Дата:** 2026-05-24
**Sub-project:** P1 of 5 (см. «Decomposition» ниже)
**Статус:** утверждено пользователем в ходе брейнсторма, готовится план реализации

---

## Decomposition Бетси-продукта (контекст)

Полное видение разбито на 5 независимых под-проектов:

| ID | Название | Зависимости |
|---|---|---|
| **P0** | Foundation: multi-mode SaaS, TG/Max каналы, memory, selfie — *уже почти готово* | — |
| **P1** | **Distribution Shell** (этот спек) — Windows-installer, wizard, control panel | P0 |
| P2 | Persona Marketplace — каталог 10+ персонажей, custom builder, animated avatars | P1 |
| P3 | Self-host Bootstrap расширение — cloud-provider OAuth (Hetzner/DO API), без SSH-кредов | P1 |
| P4 | Hosted SaaS — биллинг, лимиты подписок, shared-бот | P1 |

Этот спек покрывает только P1. Каждый из P2–P4 получит свой спек.

---

## 1. Goal

Дать пользователю установить Бетси на Windows одним `.exe`, провести через wizard первого запуска и получить работающий чат — независимо от того, выбрал он подписку (engine у нас) или self-host (engine на его VPS).

## 2. Зафиксированные решения

| Решение | Значение |
|---|---|
| Платформа в P1 | Только Windows (Mac/Linux — позже) |
| Wrapper | Electron + electron-builder + electron-updater. UI переиспользует `src/ui/` (React+Tailwind+Vite) |
| Где работает engine | **Удалённо.** В hosted — на нашей инфре. В self-host — на VPS юзера. Локально на Windows-машине engine не запускается (иначе бот молчит когда комп выключен). |
| Installer | Один `Betsy-Setup.exe`. Режим (hosted / self-host) выбирается в wizard. Миграция между режимами — отдельный спек после P1. |
| Self-host деплой | Wizard сам ставит на VPS через SSH + Docker. Юзер вводит SSH-креды. |
| Auth (hosted) | Telegram login через deep link `t.me/betsyai_bot?start=<nonce>`. Заодно привязывает TG-чат. |
| TG-бот | По дефолту наш `@betsyai_bot` в hosted. В self-host — обязан свой (наш бот не может работать с чужим VPS-бэкендом). |
| Персонажи в P1 | 2 встроенных (`betsy-default`, `betsy-pro`). Маркетплейс и анимация — P2. |
| Wizard ведёт персонаж | Выбор персонажа — первый шаг. Дальше его аватар + реплики на каждом шаге wizard'а (статичные строки из `wizardLines`, без LLM-вызовов). |
| Source of truth | Наш cloud-hub. Catalog персонажей, Docker images engine, update-манифесты — всё у нас. Оба режима пулят с hub. |
| Auto-update Electron shell | Через `electron-updater` + наш `updates.betsyai.io`. Одинаково в обоих режимах. |
| Auto-update engine (hosted) | Мы апдейтим rolling deploy. Юзер ничего не делает. |
| Auto-update engine (self-host) | Notification в Windows-app → юзер жмёт «Обновить мой сервер» → app по SSH делает `docker compose pull && up -d`. Опционально toggle «обновлять автоматом». |
| SSH-creds storage | Через Electron `safeStorage` (DPAPI). Опт-аут «спрашивать каждый раз». |

## 3. Архитектура

### 3.1 Компонентная диаграмма

```
┌─ Windows machine ─────────────────────────────────────┐
│  Betsy.exe (Electron)                                 │
│  ├─ main process (Node)                               │
│  │  ├─ wizard-engine                                  │
│  │  ├─ ssh-bootstrap        (ssh2 + docker-compose)   │
│  │  ├─ hosted-auth          (TG deep-link + poll)     │
│  │  ├─ persona-cache        (SQLite + blob storage)   │
│  │  ├─ backend-connector    (WSS → engine)            │
│  │  ├─ secure-storage       (safeStorage / DPAPI)     │
│  │  └─ updater              (electron-updater)        │
│  └─ renderer (React, переиспользуем src/ui)           │
│     ├─ WizardScreens (PersonaPicker, ModeSelect, ...) │
│     ├─ MainChatWindow                                 │
│     └─ ControlPanel                                   │
└───────────────────────────────────────────────────────┘
                │ WSS (jwt)
                ▼
┌─ Remote engine (src/multi/server.ts) ─────────────────┐
│  hosted: наш VPS, multi-tenant (RLS per workspace)    │
│  self-host: VPS юзера, тот же бинарь, один workspace  │
└───────────────────────────────────────────────────────┘

┌─ Наша cloud-инфра (всегда) ───────────────────────────┐
│  - Hosted engine (для подписчиков)                    │
│  - Docker registry: betsyai/betsy-multi:vX.Y.Z        │
│  - Catalog API: /catalog/personas, /catalog/skills    │
│  - Update manifests: /updates/electron/win-x64/...    │
│                       /updates/engine/...             │
│  - TG-auth bridge: /auth/tg-link/{start,poll}         │
│  - @betsyai_bot (handler для deep-link /start)        │
└───────────────────────────────────────────────────────┘
```

### 3.2 Ключевое архитектурное решение

**Self-host и hosted — один и тот же бинарь engine** (`src/multi/server.ts`). Различаются только средой (наш k8s vs одиночный docker compose на VPS юзера) и числом workspaces (multi-tenant vs один). Это значит:
- ~95% кода engine уже есть.
- Новый код P1 = Electron-shell + два моста (SSH-bootstrap, TG-deep-link) + persona `wizardLines` + несколько catalog/auth-endpoint'ов в `src/multi/`.

## 4. Wizard flow

Графическая версия зафиксирована в брейнсторме (`wizard-flow-v2.html`). Последовательность экранов:

1. **Persona picker** — карточки 2 встроенных персонажей. Шапка нейтральная.
2. **Mode select** — две карты:
   - «Хостим у нас» (подписка) — пуш на recommended
   - «На моём VPS» (self-host) — рядом чек-лист «понадобится: VPS, SSH, Docker, бот в @BotFather»
   - Внизу подсказка персонажа: «Если ничего из правого нет — выбирай левое»
3. **Hosted-ветка**:
   - 3H. TG login intro («открою тебе мой чат») → `shell.openExternal(deepLink)`
   - 4H. Ждём `/start <nonce>` (poll до 60c)
5. **Self-host-ветка**:
   - 3S. SSH-креды форма (host, port, user, password/key)
   - 4S. Install progress (stream stdout `docker compose pull`)
   - 5S. Свой TG-бот: токен из @BotFather → app прописывает webhook
6. **Done** — закрытие wizard'а, открытие main window.

С шага 2 на каждом экране сверху — аватар выбранного персонажа + строка из `wizardLines`.

## 5. Persona schema additions

В `src/multi/personas/types.ts` добавляем:

```typescript
interface Persona {
  id: string;
  name: string;
  // ... existing fields ...

  avatar: {
    static: string;        // URL к статичной картинке (CDN)
    voiceSample?: string;  // короткий wav/mp3 для preview
  };

  wizardLines: {
    mode_intro: string;
    mode_hosted_pitch?: string;
    mode_selfhost_checklist: string[];
    mode_selfhost_hint: string;

    tg_login_intro: string;
    tg_login_waiting: string;
    tg_login_success: string;

    ssh_prompt: string;
    ssh_test_ok: string;
    install_progress: string;
    install_done: string;
    bot_token_prompt: string;
    bot_webhook_ok: string;

    wizard_complete: string;
  };
}
```

**Источник правды:** наш hub возвращает каталог через `GET /catalog/personas`.

**Когда заполняется кеш:** при самом первом запуске Windows-app (до wizard'а) идёт `fetch /catalog/personas` + скачивание аватаров → SQLite + blob-cache. Если интернета нет на этом этапе — app показывает экран «Нет интернета, проверь подключение» и не запускает wizard. После заполнения кеша wizard читает только локально.

**Что offline, что online в wizard'е:**
- Offline (из кеша): рендеринг экранов, аватары, фразы персонажа, валидация форм
- Online: `POST /auth/tg-link/start` + poll (hosted ветка), SSH-команды к VPS юзера + Docker pull с нашего registry (self-host ветка)

Self-host ветка не зависит от того, что engine ещё не развёрнут — все network calls идут к нашему hub и SSH, не к будущему engine.

**Реальный контент** (имена, аватары, тексты `wizardLines`) пишем при заполнении репо персонажей — в спеке фиксируется только структура.

## 6. Self-host SSH-bootstrap

Алгоритм работы `betsy-app/main/ssh-bootstrap.ts` при шаге 4S:

1. **Проверки**:
   - `ssh2` auth (пароль или приватный ключ)
   - `uname -a` → Linux?
   - `docker --version || curl -fsSL https://get.docker.com | sh`
   - `docker compose version`
   - `df -h /` → ≥10GB свободно
   - На любом фейле — explicit error message с инструкцией

2. **Деплой**:
   - `mkdir -p /opt/betsy-multi`
   - `scp` загружает `docker-compose.template.yml` + сгенерированный `.env`:
     - `BC_TG_BOT_TOKEN` — пустой (заполнится на 5S)
     - `BC_DB_PASSWORD` — random, сохраняем в `safeStorage` для последующих update-команд
     - `BC_JWT_SECRET` — random
     - `BC_PUBLIC_URL` — `http://<vps-ip>:3777` (HTTPS — в отдельном спеке про reverse proxy)
     - `BC_PERSONA_ID` — id выбранного персонажа
   - `docker compose pull` — stream stdout → renderer прогресс
   - `docker compose up -d`
   - Ждём `curl localhost:3777/healthz` → ok (timeout 120s)

3. **Webhook** (шаг 5S):
   - Валидируем bot token через `https://api.telegram.org/bot<token>/getMe`
   - По SSH сохраняем токен в `.env`, `docker compose restart`
   - Windows-app дёргает `setWebhook` на `<vps>:3777/tg/webhook` через Telegram API

**Edge cases**:
- VPS без curl/docker → понятный error + инструкция по поддерживаемым ОС
- Port 3777 занят → fallback на 3877, обновляем `.env`
- SSH disconnect посреди → resume на текущем шаге (`docker compose up -d` идемпотентен)
- Юзер не успел создать бота → можно скипнуть 5S, дозаполнить из control panel

## 7. Hosted TG-deep-link login

```
Windows-app                 Backend                 @betsyai_bot
    │ POST /auth/tg-link/start                            │
    │ {personaId}                                          │
    │ ──────────────▶                                      │
    │ ◀─────────────  {nonce, deepLink}                    │
    │                                                      │
    │ shell.openExternal(deepLink)                         │
    │                                                      │
    │              [user clicks Start in TG]               │
    │                            ◀─ /start <nonce> ───────│
    │                            ─ ack ──────────────────▶│
    │                            creates workspace,        │
    │                            binds chat_id             │
    │                                                      │
    │ GET /auth/tg-link/poll?nonce  (long-poll до 60s)    │
    │ ──────────────▶                                      │
    │ ◀─────────────  {jwt, workspaceId}                   │
```

**Детали**:
- `nonce` — UUIDv4, валиден 5 минут, single-use
- Workspace создаётся в момент `/start <nonce>` в bot-handler'е, persona подставляется по сохранённому `personaId`
- jwt используется Windows-app для всех WS-коннектов к engine

## 8. Main window (P1 scope)

- Чат с remote engine через WSS (то же что `src/channels/browser`). jwt в headers.
- Аватар — **статичная картинка** из persona-cache.
- Стриминг ответа по токенам (engine уже умеет).
- Voice messages / video circles — **только проигрывание** того что engine прислал (TG/Max они уже работают напрямую через engine).
- Disconnect-баннер + retry.
- Реконнект при пробуждении из сна.

Богатый UI (анимированный аватар, lip-sync видео-кружки в окне) — P2.

## 9. Control panel

Отдельная вкладка/modal main window:

- **Status**: режим (hosted/self-host), версия engine, latency
- **Персонаж**: текущий + «Сменить» (открывает persona-picker, без перезапуска)
- **Engine update** (self-host only): «v1.2.3 → v1.2.4, [Обновить]» + опциональный auto-update toggle
- **Открыть админ-веб**: `shell.openExternal` на engine web-UI (там MCP/skills/memory)
- **Выйти**: clear jwt + reset wizard state, не трогает engine
- **Снести Бетси с VPS** (self-host only): `docker compose down && rm -rf /opt/betsy-multi`, с confirm

## 10. Auto-update channels

| Канал | Куда | Кто | Когда |
|---|---|---|---|
| Electron shell (.exe) | `updates.betsyai.io/electron/win-x64/latest.json` | `electron-updater` | Чек раз в 4 часа в фоне, применение при следующем закрытии. Юзер может отложить. |
| Engine (hosted) | rolling deploy на нашем k8s | мы | Когда мы релизим |
| Engine (self-host) | `updates.betsyai.io/engine/latest.json` | Windows-app по SSH | Notification → юзер жмёт «Обновить» (либо auto-update toggle) |

Манифест `/updates/engine/latest.json` содержит `min_shell_version`. Если engine отвечает 426 — Windows-app тригерит сначала self-update shell, потом engine.

## 11. Code-signing и distribution

- **EV Code Signing Certificate** — закупаем (DigiCert / Sectigo), ~$300-500/год.
- `.pfx` + password — в GitHub Actions secret (base64).
- `electron-builder` подписывает `.exe` и обновления в CI на release-теге.
- До получения EV — self-signed, юзеры видят SmartScreen-warning первое время (не блокер).
- `release.yml` workflow:
  1. На теге `v*` — `electron-builder --win --x64`
  2. Загружаем `Betsy-Setup-X.Y.Z.exe` + `latest.yml` + blockmap на R2/S3
  3. Обновляем `latest.json` манифест
- Public download: `betsyai.io/download` → `Betsy-Setup-latest.exe`
- Размер: ~150MB

## 12. Изменения в коде

### Новые файлы

```
betsy-app/                           # новый пакет в монорепо
├── main/
│   ├── index.ts                    # Electron entry
│   ├── wizard-engine.ts
│   ├── ssh-bootstrap.ts            # ssh2 + docker-compose + progress
│   ├── hosted-auth.ts              # TG deep-link + poll
│   ├── persona-cache.ts            # SQLite + blob cache
│   ├── backend-connector.ts        # WSS к engine
│   ├── secure-storage.ts           # safeStorage wrapper
│   └── updater.ts                  # electron-updater wrapper
├── renderer/
│   ├── Wizard/
│   │   ├── PersonaPicker.tsx
│   │   ├── ModeSelect.tsx
│   │   ├── HostedAuth.tsx
│   │   ├── SshForm.tsx
│   │   ├── InstallProgress.tsx
│   │   └── BotTokenForm.tsx
│   ├── MainChat/
│   │   ├── ChatWindow.tsx
│   │   └── AvatarPanel.tsx
│   └── ControlPanel/
│       ├── StatusTab.tsx
│       ├── PersonaTab.tsx
│       ├── EngineUpdateTab.tsx
│       └── DangerZoneTab.tsx
├── resources/
│   ├── docker-compose.template.yml
│   └── icons/
├── package.json
├── electron-builder.json
└── tsconfig.json
```

### Изменения в существующем коде

| Файл | Что |
|---|---|
| `src/multi/personas/types.ts` | + `avatar`, `wizardLines` поля |
| `src/multi/personas/repo.ts` | + `betsy-default`, `betsy-pro` встроенные |
| `src/multi/server.ts` | + endpoints `/catalog/personas`, `/auth/tg-link/start`, `/auth/tg-link/poll` |
| `src/multi/channels/telegram.ts` | модификация `/start` handler — детект nonce, привязка workspace |
| `src/multi/workspaces/repo.ts` | + `createFromTelegramLogin(tgUserId, personaId)` |

### Новая инфра

| Что | Где |
|---|---|
| Docker registry | GitHub Container Registry (`ghcr.io/betsyai/betsy-multi`) |
| Update server | Cloudflare R2 за `updates.betsyai.io` (статика) |
| Update manifest builder | GitHub Actions workflow генерирует `latest.json` при release |
| Public download page | `betsyai.io/download` (статика) |

## 13. Testing strategy

| Что | Как |
|---|---|
| Wizard happy-path hosted | Electron e2e (Playwright + electron driver), мокаем TG-deep-link backend |
| Wizard happy-path self-host | Local SSH-сервер в Docker (`sshd-test-container`), wizard ставит на него Бетси, проверяем `curl localhost:3777/healthz` |
| Persona schema | Unit-тесты на `personas/repo.ts` + zod schema |
| SSH-bootstrap edge cases | Unit с моками `ssh2` + integration на test-container |
| Hosted auth | Vitest на backend endpoints + integration с реальным test-ботом в private TG-канале |
| Update flow | Manually для первых релизов (v0.1.1 после v0.1.0). После P1 — авто на staging update server. |
| Code-sign | Smoke-test после релиза: скачать `.exe` с прода, запустить на чистой Windows VM — SmartScreen не пугает |

## 14. Риски и митигации

| Риск | Митигация |
|---|---|
| SmartScreen пугает до EV-cert | Закупаем EV параллельно P1; до получения — Download page предупреждает |
| Юзер вводит SSH-креды от рабочего сервера | Warning перед install: «Это перезапишет /opt/betsy-multi/». Confirm. |
| TG-deep-link не открывается из Electron | Fallback: показываем URL текстом + «Скопировать» |
| Engine self-host обновился, shell старый — API сломалось | Manifest с `min_shell_version`. Engine 426 если shell старый → shell обновляется первым. |
| Юзер потерял доступ к VPS | Control panel не дёргает SSH, не паникует. Кнопка «Reset SSH-credentials». |
| `docker compose pull` падает посреди установки | Idempotent retry с текущего шага |
| Один и тот же `nonce` использован дважды | Single-use гарантировано в `/auth/tg-link/start` (mark used) |

## 15. Что НЕ входит в P1 (явно отложено)

- Marketplace 10+ персонажей, custom builder, анимированные/lip-sync avatars → **P2**
- Биллинг/Stripe, лимиты подписок → **P4**
- Self-host через cloud-provider OAuth (Hetzner/DO API) → **P3**
- Mac/Linux версии
- Max-messenger в wizard (engine уже умеет — включается из control panel)
- Миграция hosted ↔ self-host (импорт памяти) → отдельный спек после P1
- HTTPS reverse proxy для self-host → отдельный спек
- Multi-window (отдельные окна для нескольких персон) → после P2
- Voice input из main window → после P2

## 16. Open items (для writing-plans)

Эти решения не блокируют дизайн, но потребуются при имплементации:

- Точные **endpoints** для catalog/auth (REST? tRPC? — скорее всего следуем существующему стилю `src/multi/server.ts`)
- Какой провайдер email транзакционных писем для возможных будущих фич (не нужно для P1 — TG login)
- Логи Electron-app — куда (Sentry? собственный endpoint?). Не блокер для P1, можно начать с file log.
- Структура `wizardLines` для двух стартовых персон — что именно говорят (контент). Пишем при заполнении репо.
