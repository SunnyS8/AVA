# Desktop Channel + Native Chat — Design

**Дата:** 2026-05-24
**Continuation of:** [P1 Distribution Shell](2026-05-24-distribution-shell-p1-design.md) — снимает заглушку `DeferredChatPlaceholder`
**Статус:** утверждено пользователем в ходе брейнсторма

---

## 1. Goal

Дать пользователю полноценный чат с Бетси прямо в Electron-окне на Windows: набираешь сообщение → стримящийся ответ + аватар. Параллельно работает Telegram-канал (если юзер пишет туда, всё видно и в окне). Бесшовность.

## 2. Зафиксированные решения

| Решение | Значение |
|---|---|
| MVP scope | Текст + аватар + стриминг по токенам. Без голоса/видео в окне, без drag-drop, без voice input — отложено. |
| История при первом подключении | Последние 50 сообщений из любого канала (TG + desktop), lazy-load по 50 на scroll вверх |
| Cross-channel routing | `workspace.lastActiveChannel` определяет куда отвечать (как сейчас) |
| Live mirror | Когда engine отвечает в TG — DesktopAdapter тоже шлёт event подключённым WS клиентам |
| Auth | JWT из P1.A (выдан wizard'ом), HS256, проверяется при WS handshake |
| Транспорт | `wss://api.betsyai.io/ws/chat` — nginx уже проксирует на 18081, TLS уже есть |
| Reconnect | Exponential backoff 1s → 30s в Electron `BackendConnector`. После reconnect — fetch `since=<lastMsgId>` для догона |
| Expired JWT | 401 при handshake → renderer показывает «Сессия истекла, открой Бетси заново» → откат на persona-picker → hosted login |

## 3. Архитектура

```
┌─ Electron renderer (betsy-app/src/renderer) ────────────────┐
│  ChatWindow                                                 │
│    ├─ MessageList (streaming bubbles, lazy-load)            │
│    ├─ AvatarPanel (статичный, в title-bar)                  │
│    └─ Composer (input + send)                               │
└────────────────────┬────────────────────────────────────────┘
                     │ IPC (window.api)
┌────────────────────▼────────────────────────────────────────┐
│  Electron main (betsy-app/src/main)                         │
│  BackendConnector                                            │
│    ├─ WS to wss://api.betsyai.io/ws/chat (Bearer jwt)       │
│    ├─ Exponential reconnect 1→30s                           │
│    ├─ fetch GET /chat/history?before=...                    │
│    └─ Emit IPC events: chat:message, chat:status, ...       │
└────────────────────┬────────────────────────────────────────┘
                     │ WSS
┌────────────────────▼────────────────────────────────────────┐
│  Multi-server (src/multi)                                   │
│  startHealthzServer + WS upgrade handler                    │
│  ├─ DesktopAdapter (implements ChannelAdapter)              │
│  │   ├─ JWT verify on handshake                             │
│  │   ├─ Map<workspaceId, WebSocket[]> connections           │
│  │   ├─ InboundEvent generation → BotRouter                 │
│  │   ├─ OutboundMessage / StreamableOutbound delivery       │
│  │   └─ Live mirror: subscribe to other adapters'           │
│  │       outbound events for active workspaces              │
│  └─ chat/history-handler.ts (REST: GET /chat/history)       │
└─────────────────────────────────────────────────────────────┘
```

## 4. Protocol (JSON over WSS)

### Client → Server

```ts
type ClientMessage =
  | { type: 'user-message'; text: string; clientMessageId: string }
  | { type: 'ping' }  // periodic, keeps connection alive
```

### Server → Client

```ts
type ServerMessage =
  | { type: 'history-batch'; messages: Message[]; hasMore: boolean }
  | { type: 'message'; message: Message }              // от Бетси, целиком (после стрима)
  | { type: 'message-delta'; messageId: string; text: string }  // streaming chunk (incremental full text)
  | { type: 'message-final'; messageId: string; text: string }
  | { type: 'message-from-other-channel'; message: Message }  // live mirror TG → desktop
  | { type: 'typing'; on: boolean }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }

interface Message {
  id: string                      // UUID
  role: 'user' | 'assistant'
  text: string
  channel: 'telegram' | 'max' | 'desktop'
  createdAt: string               // ISO 8601
  attachments?: Attachment[]      // в MVP всегда [] для desktop, но shape готов
}

interface Attachment {
  kind: 'image' | 'voice' | 'video'
  url: string                     // CDN URL, временный
  mimeType: string
}
```

**message-delta семантика:** каждый chunk содержит ПОЛНЫЙ накопленный текст (не дельту). Это упрощает renderer (просто replace text по messageId).

## 5. REST endpoint для истории

```
GET /chat/history?before=<messageId>&limit=50
Authorization: Bearer <jwt>
```

- Без `before` → 50 самых свежих
- С `before` → 50 сообщений до указанного (для scroll-up)
- Сортировка по `created_at DESC` (отдаём в порядке от новых к старым, renderer переворачивает для display)
- 200 → `{ messages: Message[], hasMore: boolean }`
- 401 → expired/missing JWT
- Использует existing `conversation_repo` (P0)

## 6. Auth flow

1. WS handshake: client (Electron) отправляет `Authorization: Bearer <jwt>` header (Node `ws` поддерживает custom headers через `WebSocket(url, { headers })`). Сервер также принимает `?token=<jwt>` query как fallback для будущего browser-клиента (если когда-то будет). На MVP — только header.
2. Сервер декодит JWT (existing `verifyJwt` из P1.A), извлекает `workspace_id`
3. Bad/expired JWT → close с code 4001 + reason "auth_failed"
4. Renderer ловит close 4001 → показывает re-auth screen
5. Юзер жмёт «Открыть wizard» → wipe wizard state → запускает persona-picker → hosted login → новый JWT

## 7. Live mirror механизм

DesktopAdapter подписывается на outbound события **всех** адаптеров для активных workspace:
- Когда `TelegramAdapter.sendMessage` отправляет успешно в TG → emit internal event `outbound:sent`
- DesktopAdapter ловит, конструирует `message-from-other-channel` payload, отправляет в активные WS connections для того же workspace
- Симметрично: если engine отправляет в desktop, TG тоже видит через TelegramAdapter (TG не делает mirror — он primary канал)

**Реализация:** в общем wiring (`runBetsy*` и cron-runners) уже есть единая точка где определяется `targetChannel` для outbound. Туда добавляется новый класс `OutboundDispatcher` (`src/multi/channels/outbound-dispatcher.ts`), который держит `Set<DesktopAdapter>` и после успешной отправки в primary channel зеркалит сообщение во все desktop-connections для того же workspace. Это **одно место изменения**, без хуков в каждом adapter'е. Telegram/Max адаптеры не знают про desktop.

## 8. Изменения в коде

### Новые файлы

```
src/multi/channels/desktop.ts            # DesktopAdapter
src/multi/chat/history-handler.ts        # GET /chat/history
src/multi/chat/types.ts                  # shared types для Message/Attachment
src/multi/ws/upgrade.ts                  # WS upgrade handler для node:http server

betsy-app/src/main/backend-connector.ts  # дописать (skeleton из P1.B)
betsy-app/src/renderer/chat/ChatWindow.tsx      # REPLACE placeholder
betsy-app/src/renderer/chat/MessageList.tsx     # bubbles + streaming + lazy-load
betsy-app/src/renderer/chat/Composer.tsx        # input + send
betsy-app/src/renderer/chat/AvatarHeader.tsx    # title-bar avatar + online status
betsy-app/src/renderer/chat/useChat.ts          # hook: state + IPC subscriptions
betsy-app/src/shared/chat-protocol.ts           # ClientMessage/ServerMessage shared
```

### Изменения в существующих файлах

| Файл | Изменение |
|---|---|
| `src/multi/channels/base.ts` | `ChannelName` += `'desktop'` |
| `src/multi/http/healthz.ts` | + `upgradeHandler?: (req, socket, head) => void` параметр |
| `src/multi/server.ts` | инициализирует DesktopAdapter + регистрирует `/chat/history` + передаёт upgrade handler в healthz |
| `src/multi/bot-router/router.ts` | добавить case для `channel === 'desktop'` в dispatching (если нужно отдельной логики — скорее всего нет, существующий path работает) |
| `src/multi/agents/runner.ts` | hook для notification после `channel.sendMessage` (для live mirror) |
| `betsy-app/src/main/index.ts` | подключить BackendConnector после wizard:done, IPC `chat:send`, `chat:onMessage`, `chat:history` |
| `betsy-app/src/preload/preload.ts` | exposes для chat IPC |
| `betsy-app/src/renderer/App.tsx` | удалить `<DeferredChatPlaceholder />` → подключить `<ChatWindow />` |
| `betsy-app/src/renderer/chat/DeferredChatPlaceholder.tsx` | DELETE |

## 9. Тестовая стратегия

| Что | Как |
|---|---|
| DesktopAdapter handshake + auth | Vitest unit + integration: спин-ап mini HTTP+WS на random port, JWT mint, connect → ack |
| Inbound event flow | Mock BotRouter, отправить WS message → assert InboundEvent передан в router |
| Outbound delivery | Mock WS clients, вызвать adapter.sendMessage → assert все connections получили JSON |
| Streaming | streamMessage с async iterable → assert delta/final events |
| Live mirror | Wire 2 adapters (Telegram mock + Desktop) → TG sendMessage → assert Desktop клиент получил `message-from-other-channel` |
| History endpoint | Real Postgres + real conversation_repo (gated на `BC_TEST_DATABASE_URL`) — assert pagination |
| Reconnect | Mock ws server закрывает connection → assert BackendConnector retry с exp backoff |
| 401 handshake | Mint expired JWT → connect → assert close 4001 в renderer + re-auth UI |
| E2E happy path | Playwright + Electron: после wizard:done открывается chat, отправка сообщения → стримящийся ответ |

## 10. Риски и митигации

| Риск | Митигация |
|---|---|
| WS connection через nginx падает после 60s idle | Periodic `ping`/`pong` каждые 30s (client) |
| Multi подписан на TG polling — что если десктоп клиент сделает echo loop через bot router | InboundEvent с `channel:'desktop'` помечается explicitly, runBetsy отвечает один раз через тот же канал |
| JWT secret компрометирован → все desktop коннекты валидны для атакующего | Если detected — rotate `BC_JWT_SECRET` в env, restart multi → все active WS closes 4001 → юзеры re-auth |
| WS sticky session между nginx и multi | Single multi instance сейчас, no LB — sticky N/A. При scale-out — потребуется sticky либо shared connection registry (Redis pub/sub) |
| Большой backlog при reconnect | `since=<lastMsgId>` limit 200; если больше — `hasMore:true`, юзер прокручивает |
| Race: одновременная отправка из TG и desktop | Engine обрабатывает messages последовательно (existing inbound coalescer); порядок receipt = order of delivery |

## 11. Что НЕ входит

- Голосовые сообщения в окне (engine их умеет генерить, но UI плеер — потом)
- Видео-кружки в окне (то же)
- Drag-drop изображений от юзера в окно
- Voice input через микрофон
- Notifications API (desktop notification когда окно не в фокусе)
- Sidebar с памятью/скилами/статусом — главное окно остаётся chat-only
- Несколько разговоров / threads / папки
- Search по истории
- Edit/delete своих сообщений (Telegram умеет, у нас будет позже)
- Анимация аватара (lip-sync, появление) — это P2 Persona Marketplace
- Файлы (PDF, docs) — не в MVP

## 12. Open items

- Точное место hook'а для live mirror (`runBetsy.ts` vs. wrapper над adapters) — определится при реализации
- Размер кэша истории в renderer — 1000 сообщений? Меньше? Решим эмпирически
- Format времени в bubbles — `14:32` vs `2 минуты назад`. По умолчанию absolute, в `--debug` режиме relative — решим при first review

---

## Decomposition notes

Это **один спек, один план**. Внутри есть две параллельные ветви — backend (`src/multi/`) и frontend (`betsy-app/`), но они через зафиксированный JSON-протокол, могут разрабатываться независимо с mock'ами. Не делю на P1.5A / P1.5B потому что:
- Объём меньше чем P1 (≈12 backend tasks + 8 frontend tasks)
- Контракт зафиксирован в этом спеке, не нужно параллельной координации
- Один executor пройдёт быстрее с overlap опции

Если в реализации станет слишком большим — write-plans разобьёт на 2.
