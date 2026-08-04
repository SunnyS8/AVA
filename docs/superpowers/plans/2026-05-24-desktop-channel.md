# Desktop Channel + Native Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Electron `DeferredChatPlaceholder` with a real chat that talks to the `multi` engine over WSS. Implement a `DesktopAdapter` channel + history endpoint on backend, BackendConnector + Chat UI on the Electron side.

**Architecture:** New `DesktopAdapter` implementing existing `ChannelAdapter` interface, plugged into the same `BotRouter` pipeline as Telegram. WS lives on the existing healthz HTTP server (18081, behind `https://api.betsyai.io` nginx proxy). JWT from the wizard auths WS handshakes. A new `OutboundDispatcher` is the single place where outbound messages get mirrored to Desktop clients when the primary channel was Telegram (live mirror). History served via a separate REST endpoint with cursor pagination over the existing `ConversationRepo`.

**Tech Stack:** TypeScript (ESM), `ws` library for WSS, raw `node:http` upgrade hook, existing `signJwt`/`verifyJwt`, Postgres via existing `ConversationRepo`, React + Tailwind for chat UI, Electron IPC. Spec: [docs/superpowers/specs/2026-05-24-desktop-channel-design.md](../specs/2026-05-24-desktop-channel-design.md).

---

## File Structure

### Backend (`src/multi/`)
- `channels/base.ts` — MODIFY: add `'desktop'` to `ChannelName` union
- `channels/desktop.ts` — NEW: `DesktopAdapter` (handshake, in/out, streaming)
- `channels/outbound-dispatcher.ts` — NEW: cross-channel live mirror coordinator
- `chat/types.ts` — NEW: shared `Message`, `Attachment`, `ClientMessage`, `ServerMessage` shapes
- `chat/history-handler.ts` — NEW: `GET /chat/history` REST handler
- `memory/conversation-repo.ts` — MODIFY: add `listBefore(workspaceId, beforeId, limit)`
- `http/healthz.ts` — MODIFY: accept optional `upgrade` handler param
- `server.ts` — MODIFY: instantiate adapter, dispatcher, register history route, pass upgrade handler

### Frontend (`betsy-app/`)
- `src/shared/chat-protocol.ts` — NEW: protocol types (mirrors `src/multi/chat/types.ts`)
- `src/main/backend-connector.ts` — MODIFY: real WS + reconnect (skeleton exists from P1.B)
- `src/main/chat-history-client.ts` — NEW: REST fetch wrapper for history
- `src/main/index.ts` — MODIFY: wire connector after `wizard:done`, IPC channels
- `src/shared/ipc-contract.ts` — MODIFY: add chat IPC channels
- `src/preload/preload.ts` — MODIFY: expose chat IPC
- `src/renderer/chat/ChatWindow.tsx` — REPLACE the placeholder
- `src/renderer/chat/MessageList.tsx` — NEW
- `src/renderer/chat/Composer.tsx` — NEW
- `src/renderer/chat/AvatarHeader.tsx` — NEW
- `src/renderer/chat/useChat.ts` — NEW: hook with state + IPC subscriptions
- `src/renderer/chat/ReAuthBanner.tsx` — NEW: shown on close 4001
- `src/renderer/App.tsx` — MODIFY: route to `<ChatWindow />` on `wizard:done`
- `src/renderer/chat/DeferredChatPlaceholder.tsx` — DELETE

### Tests
- `tests/multi/channels/desktop.test.ts` — NEW
- `tests/multi/channels/outbound-dispatcher.test.ts` — NEW
- `tests/multi/chat/history-handler.test.ts` — NEW
- `tests/multi/memory/conversation-repo.test.ts` — EXTEND with `listBefore`
- `tests/multi/server/desktop-wire.test.ts` — NEW: integration handshake
- `betsy-app/tests/unit/backend-connector.test.ts` — NEW
- `betsy-app/tests/unit/chat-history-client.test.ts` — NEW
- `betsy-app/tests/unit/use-chat.test.ts` — NEW
- `betsy-app/tests/e2e/desktop-chat.test.ts` — NEW: hosted chat happy path

---

## Task 1: ChannelName union extended + WS upgrade hook in healthz

**Files:**
- Modify: `src/multi/channels/base.ts:1`
- Modify: `src/multi/http/healthz.ts:29-67`
- Test: `tests/multi/http/healthz.test.ts` (extend existing)

- [ ] **Step 1: Extend ChannelName union**

Change line 1 of `src/multi/channels/base.ts`:

```typescript
export type ChannelName = 'telegram' | 'max' | 'desktop'
```

- [ ] **Step 2: Run typecheck — expect many errors**

```bash
npm run typecheck
```

Expected: errors in places that exhaustively switch on `ChannelName`. Note the locations; fix in **Step 3** by adding `case 'desktop':` no-ops (the real desktop handling lives in `DesktopAdapter`).

- [ ] **Step 3: Fix exhaustive switches**

For each file with a "not all union members handled" error on a switch over `ChannelName`:
- If the switch decides typing/sendMessage behavior — add `case 'desktop':` and route through the same path as `'telegram'`/`'max'` (channels are interchangeable from BotRouter's view).
- If it's a pre-existing TODO branch — fall through to a default case.

Run `npm run typecheck` until green.

- [ ] **Step 4: Extend healthz with upgrade handler hook**

Replace `startHealthzServer` signature in `src/multi/http/healthz.ts`:

```typescript
export interface HealthzServerOptions {
  extraRoutes?: ExtraRoute[]
  /** Optional handler for WS upgrade requests (e.g. /ws/chat). */
  upgrade?: (req: http.IncomingMessage, socket: import('node:net').Socket, head: Buffer) => void
}

export function startHealthzServer(
  port: number,
  pool: Pool,
  optsOrExtraRoutes: HealthzServerOptions | ExtraRoute[] = [],
): http.Server {
  // Backwards-compat: old call sites passed `extraRoutes` array directly.
  const opts: HealthzServerOptions = Array.isArray(optsOrExtraRoutes)
    ? { extraRoutes: optsOrExtraRoutes }
    : optsOrExtraRoutes
  const extraRoutes = opts.extraRoutes ?? []

  const server = http.createServer(async (req, res) => {
    // ...existing routing body unchanged...
  })

  if (opts.upgrade) {
    server.on('upgrade', opts.upgrade)
  }

  server.listen(port)
  return server
}
```

- [ ] **Step 5: Write tests**

Add to `tests/multi/http/healthz.test.ts`:

```typescript
import { startHealthzServer } from '../../../src/multi/http/healthz.js'
import { Pool } from 'pg'
import WebSocket from 'ws'

it('invokes upgrade handler on /ws/chat', async () => {
  const upgradeCalls: string[] = []
  const server = startHealthzServer(0, {} as Pool, {
    upgrade: (req) => {
      upgradeCalls.push(req.url ?? '')
      req.socket.destroy() // close immediately for the test
    },
  })
  const { port } = server.address() as { port: number }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`)
  await new Promise<void>((resolve) => ws.on('close', () => resolve()))
  expect(upgradeCalls).toContain('/ws/chat')
  server.close()
})

it('still serves /healthz when upgrade handler set', async () => {
  const server = startHealthzServer(0, {} as Pool, {
    upgrade: () => {},
  })
  const { port } = server.address() as { port: number }
  const res = await fetch(`http://127.0.0.1:${port}/healthz`)
  // dbCheck will throw because pool is empty mock -> 503 not 200,
  // but the route is still reachable.
  expect([200, 503]).toContain(res.status)
  server.close()
})
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run tests/multi/http/healthz.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/multi/channels/base.ts src/multi/http/healthz.ts tests/multi/http/healthz.test.ts
git commit -m "feat(channels): add 'desktop' to ChannelName + WS upgrade hook in healthz"
```

---

## Task 2: Chat protocol types

**Files:**
- Create: `src/multi/chat/types.ts`
- Create: `betsy-app/src/shared/chat-protocol.ts`

Both files must be byte-identical content (shared contract). To avoid drift in P1.5, a follow-up task can extract to a shared workspace, but for now we duplicate.

- [ ] **Step 1: Write the types**

```typescript
// src/multi/chat/types.ts (and identical at betsy-app/src/shared/chat-protocol.ts)

export type MessageRole = 'user' | 'assistant'
export type MessageChannel = 'telegram' | 'max' | 'desktop'

export interface Attachment {
  kind: 'image' | 'voice' | 'video'
  url: string         // CDN/temporary URL
  mimeType: string
}

export interface Message {
  id: string
  role: MessageRole
  text: string
  channel: MessageChannel
  createdAt: string   // ISO 8601
  attachments?: Attachment[]
}

// Client -> Server (over WSS)
export type ClientMessage =
  | { type: 'user-message'; text: string; clientMessageId: string }
  | { type: 'ping' }

// Server -> Client (over WSS)
export type ServerMessage =
  | { type: 'history-batch'; messages: Message[]; hasMore: boolean }
  | { type: 'message'; message: Message }
  | { type: 'message-delta'; messageId: string; text: string }
  | { type: 'message-final'; messageId: string; text: string }
  | { type: 'message-from-other-channel'; message: Message }
  | { type: 'typing'; on: boolean }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
```

- [ ] **Step 2: Create both files**

Same content in both:
- `src/multi/chat/types.ts`
- `betsy-app/src/shared/chat-protocol.ts`

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
cd betsy-app && npx tsc --noEmit -p tsconfig.main.json && cd ..
```

Expected: clean

- [ ] **Step 4: Commit**

```bash
git add src/multi/chat/types.ts betsy-app/src/shared/chat-protocol.ts
git commit -m "feat(chat): shared protocol types (ClientMessage/ServerMessage/Message)"
```

---

## Task 3: ConversationRepo.listBefore

**Files:**
- Modify: `src/multi/memory/conversation-repo.ts:139` (add method near `recent`)
- Test: `tests/multi/memory/conversation-repo.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `tests/multi/memory/conversation-repo.test.ts`:

```typescript
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { ConversationRepo } from '../../../src/multi/memory/conversation-repo.js'

const BC_TEST_DATABASE_URL = process.env.BC_TEST_DATABASE_URL

describe.skipIf(!BC_TEST_DATABASE_URL)('ConversationRepo.listBefore', () => {
  let pool: Pool
  let repo: ConversationRepo
  const ws = '00000000-0000-0000-0000-000000004444'

  beforeAll(() => {
    pool = new Pool({ connectionString: BC_TEST_DATABASE_URL })
    repo = new ConversationRepo(pool, { embedContent: async () => null } as any)
  })
  afterAll(async () => { await pool.end() })
  beforeEach(async () => {
    await pool.query(`insert into workspaces (id) values ($1) on conflict do nothing`, [ws])
    await pool.query(`delete from bc_conversation where workspace_id = $1`, [ws])
  })

  it('lists messages strictly before a given id, newest-first, limit honored', async () => {
    const inserted: string[] = []
    for (let i = 0; i < 5; i++) {
      const c = await repo.append(ws, { role: 'user', content: `msg-${i}`, channel: 'desktop' })
      inserted.push(c.id)
    }
    // Inserted oldest -> newest: msg-0, msg-1, msg-2, msg-3, msg-4
    // listBefore(ws, inserted[3], 10) should yield [msg-2, msg-1, msg-0] (newest of the older set first)
    const result = await repo.listBefore(ws, inserted[3], 10)
    expect(result.map((r) => r.content)).toEqual(['msg-2', 'msg-1', 'msg-0'])
  })

  it('listBefore with no cursor returns latest N', async () => {
    for (let i = 0; i < 3; i++) {
      await repo.append(ws, { role: 'user', content: `x-${i}`, channel: 'desktop' })
    }
    const result = await repo.listBefore(ws, null, 10)
    expect(result.map((r) => r.content)).toEqual(['x-2', 'x-1', 'x-0'])
  })

  it('listBefore respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      await repo.append(ws, { role: 'user', content: `y-${i}`, channel: 'desktop' })
    }
    const result = await repo.listBefore(ws, null, 3)
    expect(result).toHaveLength(3)
    expect(result[0].content).toBe('y-9')
  })

  it('listBefore with unknown cursor returns empty', async () => {
    await repo.append(ws, { role: 'user', content: 'a', channel: 'desktop' })
    const result = await repo.listBefore(ws, '00000000-0000-0000-0000-deadbeef0000', 10)
    expect(result).toEqual([])
  })
})
```

- [ ] **Step 2: Verify it fails**

```bash
BC_TEST_DATABASE_URL=$BC_TEST_DATABASE_URL npx vitest run tests/multi/memory/conversation-repo.test.ts
```

Expected: FAIL — `repo.listBefore is not a function`.

- [ ] **Step 3: Add the method**

In `src/multi/memory/conversation-repo.ts`, near the `recent` method (around line 139):

```typescript
/**
 * Page through history backwards. `beforeId` = exclusive upper-bound cursor
 * (the message with that id is NOT in the result). Pass `null` to get the
 * latest `limit` messages.
 *
 * Returns rows newest-first within the page so the caller can append to
 * a top-of-list "older messages" section in order.
 *
 * If `beforeId` is unknown the result is empty (we cannot derive a created_at
 * cursor from it).
 */
async listBefore(
  workspaceId: string,
  beforeId: string | null,
  limit: number,
): Promise<Conversation[]> {
  return withWorkspace(this.pool, workspaceId, async (client) => {
    if (beforeId === null) {
      const { rows } = await client.query(
        `select * from bc_conversation
         where workspace_id = $1
         order by created_at desc
         limit $2`,
        [workspaceId, limit],
      )
      return rows.map(rowToConversation)
    }

    // Get the cursor row's created_at; if cursor is unknown we return [] —
    // the client probably has stale state and will refresh via no-cursor.
    const cursor = await client.query(
      `select created_at from bc_conversation
       where workspace_id = $1 and id = $2`,
      [workspaceId, beforeId],
    )
    if (cursor.rows.length === 0) return []
    const beforeCreatedAt: Date = cursor.rows[0].created_at

    const { rows } = await client.query(
      `select * from bc_conversation
       where workspace_id = $1 and created_at < $2
       order by created_at desc
       limit $3`,
      [workspaceId, beforeCreatedAt, limit],
    )
    return rows.map(rowToConversation)
  })
}
```

If `rowToConversation` is not already a private helper in the file, add one mirroring the row -> object shape used by `recent`/`append`.

- [ ] **Step 4: Run tests, expect pass**

```bash
BC_TEST_DATABASE_URL=$BC_TEST_DATABASE_URL npx vitest run tests/multi/memory/conversation-repo.test.ts
```

Expected: PASS (4 new tests + pre-existing ones still green).

- [ ] **Step 5: Commit**

```bash
git add src/multi/memory/conversation-repo.ts tests/multi/memory/conversation-repo.test.ts
git commit -m "feat(conversation): listBefore — cursor pagination for chat history"
```

---

## Task 4: GET /chat/history endpoint

**Files:**
- Create: `src/multi/chat/history-handler.ts`
- Modify: `src/multi/server.ts` (register route)
- Test: `tests/multi/chat/history-handler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/multi/chat/history-handler.test.ts
import { describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { Readable } from 'node:stream'
import { createHistoryHandler } from '../../../src/multi/chat/history-handler.js'

function mockReq(opts: { headers?: Record<string, string>; url?: string }): http.IncomingMessage {
  const r = new Readable() as any
  r.headers = opts.headers ?? {}
  r.url = opts.url ?? '/chat/history'
  r.method = 'GET'
  r._read = () => {}
  return r
}
function mockRes(): http.ServerResponse & { _body: string; _status: number; _headers: Record<string, string> } {
  let _body = ''
  let _status = 0
  const _headers: Record<string, string> = {}
  return {
    setHeader: (k: string, v: string) => { _headers[k.toLowerCase()] = v },
    writeHead: (s: number, h?: Record<string, string>) => {
      _status = s
      if (h) for (const k of Object.keys(h)) _headers[k.toLowerCase()] = h[k]
    },
    end: (chunk: string = '') => { _body += chunk },
    get _body() { return _body },
    get _status() { return _status },
    get _headers() { return _headers },
  } as any
}

describe('GET /chat/history', () => {
  it('returns 401 without Authorization header', async () => {
    const handler = createHistoryHandler({ verifyJwt: () => null, listBefore: vi.fn() })
    const res = mockRes()
    await handler(mockReq({}), res)
    expect(res._status).toBe(401)
  })

  it('returns 401 with invalid JWT', async () => {
    const handler = createHistoryHandler({
      verifyJwt: () => null,
      listBefore: vi.fn(),
    })
    const res = mockRes()
    await handler(mockReq({ headers: { authorization: 'Bearer fake' } }), res)
    expect(res._status).toBe(401)
  })

  it('returns 200 + messages when authed, no cursor', async () => {
    const fakeMessages = [
      { id: 'm1', role: 'assistant', content: 'hi', channel: 'desktop', createdAt: new Date('2026-05-24T10:00:00Z') },
    ]
    const handler = createHistoryHandler({
      verifyJwt: () => ({ sub: 'ws-abc' }),
      listBefore: vi.fn(async (ws, before, limit) => {
        expect(ws).toBe('ws-abc')
        expect(before).toBe(null)
        expect(limit).toBe(50)
        return fakeMessages
      }),
    })
    const res = mockRes()
    await handler(mockReq({ headers: { authorization: 'Bearer x' } }), res)
    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].id).toBe('m1')
    expect(body.hasMore).toBe(false)
  })

  it('passes ?before=<id>&limit=20 through to listBefore', async () => {
    const handler = createHistoryHandler({
      verifyJwt: () => ({ sub: 'ws-x' }),
      listBefore: vi.fn(async () => []),
    })
    const res = mockRes()
    await handler(mockReq({
      headers: { authorization: 'Bearer x' },
      url: '/chat/history?before=msg-123&limit=20',
    }), res)
    expect(res._status).toBe(200)
  })

  it('hasMore=true when limit messages returned', async () => {
    const handler = createHistoryHandler({
      verifyJwt: () => ({ sub: 'ws-x' }),
      listBefore: vi.fn(async () => Array.from({ length: 50 }, (_, i) => ({
        id: `m${i}`, role: 'user' as const, content: `t${i}`, channel: 'desktop' as const,
        createdAt: new Date(),
      }))),
    })
    const res = mockRes()
    await handler(mockReq({ headers: { authorization: 'Bearer x' } }), res)
    const body = JSON.parse(res._body)
    expect(body.hasMore).toBe(true)
    expect(body.messages).toHaveLength(50)
  })

  it('clamps limit to 200', async () => {
    let receivedLimit = 0
    const handler = createHistoryHandler({
      verifyJwt: () => ({ sub: 'ws-x' }),
      listBefore: async (_ws, _before, limit) => { receivedLimit = limit; return [] },
    })
    const res = mockRes()
    await handler(mockReq({
      headers: { authorization: 'Bearer x' },
      url: '/chat/history?limit=10000',
    }), res)
    expect(receivedLimit).toBe(200)
  })
})
```

- [ ] **Step 2: Implement the handler**

```typescript
// src/multi/chat/history-handler.ts
import type http from 'node:http'
import type { Message } from './types.js'
import type { Conversation } from '../memory/conversation-repo.js'

export interface HistoryHandlerDeps {
  /** Returns the decoded payload `{ sub: workspaceId }` or null. */
  verifyJwt: (token: string) => { sub: string } | null
  /** Backed by ConversationRepo.listBefore. */
  listBefore: (workspaceId: string, beforeId: string | null, limit: number) => Promise<Conversation[]>
}

function convToMessage(c: Conversation): Message {
  return {
    id: c.id,
    role: c.role,
    text: c.content,
    channel: (c.channel ?? 'desktop') as Message['channel'],
    createdAt: c.createdAt.toISOString(),
  }
}

export function createHistoryHandler(
  deps: HistoryHandlerDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const auth = req.headers.authorization ?? ''
    const m = /^Bearer\s+(.+)$/i.exec(auth)
    if (!m) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing bearer token' }))
      return
    }
    const payload = deps.verifyJwt(m[1])
    if (!payload) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid token' }))
      return
    }

    const url = new URL(req.url ?? '/', 'http://x')
    const before = url.searchParams.get('before')
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '50', 10)
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200)

    const convs = await deps.listBefore(payload.sub, before, limit)
    const messages = convs.map(convToMessage)
    const body = { messages, hasMore: messages.length === limit }

    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    })
    res.end(JSON.stringify(body))
  }
}
```

- [ ] **Step 3: Register the route in server.ts**

In `src/multi/server.ts`, where other `extraRoutes` get composed (look for the `tg-link-http` registration), add:

```typescript
import { createHistoryHandler } from './chat/history-handler.js'
// ...
const historyRoute: ExtraRoute = {
  method: 'GET',
  path: '/chat/history',
  handler: createHistoryHandler({
    verifyJwt: (token) => {
      const payload = verifyJwt(token, env.BC_JWT_SECRET)  // import the existing verifyJwt
      return payload ? { sub: payload.sub as string } : null
    },
    listBefore: (ws, before, limit) => convRepo.listBefore(ws, before, limit),
  }),
}
// Add `historyRoute` to the extraRoutes array passed to startHealthzServer.
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/multi/chat/history-handler.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/multi/chat/history-handler.ts src/multi/server.ts tests/multi/chat/history-handler.test.ts
git commit -m "feat(chat): GET /chat/history endpoint with JWT auth and cursor pagination"
```

---

## Task 5: DesktopAdapter — class skeleton + handshake

**Files:**
- Create: `src/multi/channels/desktop.ts`
- Test: `tests/multi/channels/desktop.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/multi/channels/desktop.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import WebSocket from 'ws'
import { DesktopAdapter } from '../../../src/multi/channels/desktop.js'

function makeServer(adapter: DesktopAdapter): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer()
    server.on('upgrade', (req, socket, head) => adapter.handleUpgrade(req, socket, head))
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

describe('DesktopAdapter handshake', () => {
  let s: { port: number; close: () => Promise<void> }
  let adapter: DesktopAdapter
  let onInbound: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    onInbound = vi.fn()
    adapter = new DesktopAdapter({
      verifyJwt: (token) => (token === 'good-jwt' ? { sub: 'ws-1' } : null),
    })
    adapter.onMessage(onInbound)
    s = await makeServer(adapter)
  })
  afterEach(async () => {
    await adapter.stop()
    await s.close()
  })

  it('accepts WS with valid Bearer JWT', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer good-jwt' },
    })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    expect(adapter.connectionsFor('ws-1')).toBe(1)
    ws.close()
  })

  it('closes with 4001 on missing JWT', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`)
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c))
    })
    expect(code).toBe(4001)
  })

  it('closes with 4001 on invalid JWT', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer bad-jwt' },
    })
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c))
    })
    expect(code).toBe(4001)
  })

  it('ignores requests to other paths', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/something-else`, {
      headers: { authorization: 'Bearer good-jwt' },
    })
    // Connection will be destroyed by upgrade handler; ws emits close 1006.
    const closed = await new Promise<boolean>((resolve) => {
      ws.on('close', () => resolve(true))
      ws.on('error', () => resolve(true))
    })
    expect(closed).toBe(true)
  })
})
```

- [ ] **Step 2: Implement DesktopAdapter (handshake-only this task)**

```typescript
// src/multi/channels/desktop.ts
import http from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, type WebSocket as WS } from 'ws'
import type {
  ChannelAdapter,
  InboundEvent,
  OutboundMessage,
  SendResult,
  StreamableOutbound,
} from './base.js'

export interface DesktopAdapterDeps {
  /** Same shape as P1.A: returns { sub: workspaceId } or null. */
  verifyJwt: (token: string) => { sub: string } | null
}

interface Conn {
  socket: WS
  workspaceId: string
}

/** Channel adapter that talks to Electron app over WebSocket. */
export class DesktopAdapter implements ChannelAdapter {
  readonly name = 'desktop' as const
  private wss = new WebSocketServer({ noServer: true })
  private connections = new Set<Conn>()
  private inboundHandlers: ((ev: InboundEvent) => Promise<void>)[] = []

  constructor(private deps: DesktopAdapterDeps) {
    this.wss.on('connection', (socket: WS, _req: http.IncomingMessage, workspaceId: string) => {
      const conn: Conn = { socket, workspaceId }
      this.connections.add(conn)
      socket.on('close', () => { this.connections.delete(conn) })
      socket.on('error', () => { /* swallow; ws emits both error and close */ })
      // Per-message handling wired in Task 6
    })
  }

  async start(): Promise<void> { /* no-op; WS server is per-connection */ }
  async stop(): Promise<void> {
    for (const c of this.connections) c.socket.close(1001, 'server-stop')
    this.connections.clear()
    this.wss.close()
  }

  onMessage(handler: (ev: InboundEvent) => Promise<void>): void {
    this.inboundHandlers.push(handler)
  }

  async sendMessage(_msg: OutboundMessage): Promise<SendResult> {
    // Implemented in Task 7
    return {}
  }

  async streamMessage(_msg: StreamableOutbound): Promise<SendResult> {
    // Implemented in Task 8
    return {}
  }

  /** Entry point: caller wires `server.on('upgrade', adapter.handleUpgrade.bind(adapter))` */
  handleUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname !== '/ws/chat') {
      socket.destroy()
      return
    }

    const auth = req.headers['authorization'] ?? ''
    const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(auth) ? auth[0] : auth)
    const token = m?.[1] ?? url.searchParams.get('token') ?? ''
    const payload = token ? this.deps.verifyJwt(token) : null
    if (!payload) {
      // Per RFC: handshake reject = 401 then close socket.
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // Some clients react better if we accept first then close with a clean
      // 4xxx code; we don't reject here because payload is already valid.
      this.wss.emit('connection', ws, req, payload.sub)
    })

    // For tests that send bad JWT (handled above) we close with 4001 via a
    // protocol-frame close after accept — but our path-not-found / no-jwt
    // branch above already destroys the socket. Add an accept-then-close
    // fallback for the case where the JWT was syntactically present but
    // semantically rejected.
  }

  /** For tests + diagnostics. */
  connectionsFor(workspaceId: string): number {
    let n = 0
    for (const c of this.connections) if (c.workspaceId === workspaceId) n++
    return n
  }
}
```

- [ ] **Step 3: Run tests, observe failures**

```bash
npx vitest run tests/multi/channels/desktop.test.ts
```

Expected: 2 PASS (good JWT + ignore other paths), 2 FAIL (the "closes with 4001" tests expect a proper WS close frame, not a raw HTTP destroy).

- [ ] **Step 4: Refine to emit 4001 close frame**

The cleanest way: always accept the WS handshake, then close with 4001 if auth fails. Replace the auth path in `handleUpgrade`:

```typescript
handleUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname !== '/ws/chat') {
    socket.destroy()
    return
  }

  const auth = req.headers['authorization'] ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(auth) ? auth[0] : auth)
  const token = m?.[1] ?? url.searchParams.get('token') ?? ''
  const payload = token ? this.deps.verifyJwt(token) : null

  this.wss.handleUpgrade(req, socket, head, (ws) => {
    if (!payload) {
      ws.close(4001, 'auth_failed')
      return
    }
    this.wss.emit('connection', ws, req, payload.sub)
  })
}
```

- [ ] **Step 5: Re-run tests, expect PASS**

```bash
npx vitest run tests/multi/channels/desktop.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/multi/channels/desktop.ts tests/multi/channels/desktop.test.ts
git commit -m "feat(channels): DesktopAdapter handshake + JWT verify"
```

---

## Task 6: DesktopAdapter inbound — receive user-message, dispatch as InboundEvent

**Files:**
- Modify: `src/multi/channels/desktop.ts`
- Modify: `tests/multi/channels/desktop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/multi/channels/desktop.test.ts`:

```typescript
describe('DesktopAdapter inbound', () => {
  let s: { port: number; close: () => Promise<void> }
  let adapter: DesktopAdapter
  let onInbound: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    onInbound = vi.fn()
    adapter = new DesktopAdapter({
      verifyJwt: () => ({ sub: 'ws-99' }),
    })
    adapter.onMessage(onInbound)
    s = await makeServer(adapter)
  })
  afterEach(async () => {
    await adapter.stop()
    await s.close()
  })

  it('emits InboundEvent on user-message', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.send(JSON.stringify({
      type: 'user-message',
      text: 'hello betsy',
      clientMessageId: 'c1',
    }))
    await new Promise((r) => setTimeout(r, 50))
    expect(onInbound).toHaveBeenCalledTimes(1)
    const ev = onInbound.mock.calls[0][0]
    expect(ev.channel).toBe('desktop')
    expect(ev.text).toBe('hello betsy')
    expect(ev.userId).toBe('ws-99')      // workspace id used as user id on desktop
    expect(ev.chatId).toBe('ws-99')
    expect(ev.messageId).toBe('c1')
    ws.close()
  })

  it('responds to ping with pong', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const reply = await new Promise<any>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())))
      ws.send(JSON.stringify({ type: 'ping' }))
    })
    expect(reply.type).toBe('pong')
    ws.close()
  })

  it('rejects malformed JSON with error frame', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const reply = await new Promise<any>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())))
      ws.send('not-json{')
    })
    expect(reply.type).toBe('error')
    ws.close()
  })
})
```

- [ ] **Step 2: Implement message handling**

Inside the `wss.on('connection', ...)` callback in `src/multi/channels/desktop.ts`, replace the `// Per-message handling wired in Task 6` comment with:

```typescript
socket.on('message', async (raw) => {
  let msg: any
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    socket.send(JSON.stringify({
      type: 'error',
      code: 'bad-json',
      message: 'message must be valid JSON',
    }))
    return
  }

  if (msg.type === 'ping') {
    socket.send(JSON.stringify({ type: 'pong' }))
    return
  }

  if (msg.type === 'user-message') {
    if (typeof msg.text !== 'string' || typeof msg.clientMessageId !== 'string') {
      socket.send(JSON.stringify({
        type: 'error',
        code: 'bad-frame',
        message: 'user-message requires text and clientMessageId',
      }))
      return
    }
    const ev: InboundEvent = {
      channel: 'desktop',
      chatId: workspaceId,
      userId: workspaceId,
      userDisplay: 'desktop',
      text: msg.text,
      messageId: msg.clientMessageId,
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: msg,
    }
    for (const handler of this.inboundHandlers) {
      try {
        await handler(ev)
      } catch (e) {
        // Don't kill the socket on handler error; just log
        console.warn(JSON.stringify({
          level: 40, msg: 'desktop inbound handler threw', error: e instanceof Error ? e.message : String(e),
        }))
      }
    }
    return
  }

  socket.send(JSON.stringify({
    type: 'error',
    code: 'unknown-type',
    message: `unknown message type: ${msg.type}`,
  }))
})
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run tests/multi/channels/desktop.test.ts
```

Expected: PASS (4 + 3 = 7 tests)

- [ ] **Step 4: Commit**

```bash
git add src/multi/channels/desktop.ts tests/multi/channels/desktop.test.ts
git commit -m "feat(channels): DesktopAdapter inbound user-message + ping/pong"
```

---

## Task 7: DesktopAdapter outbound — sendMessage to active connections

**Files:**
- Modify: `src/multi/channels/desktop.ts`
- Modify: `tests/multi/channels/desktop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/multi/channels/desktop.test.ts`:

```typescript
describe('DesktopAdapter outbound sendMessage', () => {
  let s: { port: number; close: () => Promise<void> }
  let adapter: DesktopAdapter

  beforeEach(async () => {
    adapter = new DesktopAdapter({ verifyJwt: () => ({ sub: 'ws-7' }) })
    s = await makeServer(adapter)
  })
  afterEach(async () => { await adapter.stop(); await s.close() })

  it('delivers OutboundMessage to active WS connection as `message` event', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))

    const received: any[] = []
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))

    await adapter.sendMessage({
      chatId: 'ws-7',
      text: 'hi from server',
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('message')
    expect(received[0].message.role).toBe('assistant')
    expect(received[0].message.text).toBe('hi from server')
    expect(received[0].message.channel).toBe('desktop')
    ws.close()
  })

  it('returns externalMessageId undefined (desktop has no platform ids)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const r = await adapter.sendMessage({ chatId: 'ws-7', text: 'x' })
    expect(r.externalMessageId).toBeUndefined()
    ws.close()
  })

  it('no-ops gracefully when workspace has no active connection', async () => {
    // No ws connected
    const r = await adapter.sendMessage({ chatId: 'ws-7', text: 'hi' })
    expect(r).toEqual({})
  })

  it('broadcasts to multiple connections from same workspace', async () => {
    const w1 = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, { headers: { authorization: 'Bearer x' } })
    const w2 = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, { headers: { authorization: 'Bearer x' } })
    await Promise.all([
      new Promise<void>((r) => w1.on('open', () => r())),
      new Promise<void>((r) => w2.on('open', () => r())),
    ])
    const r1: any[] = []; const r2: any[] = []
    w1.on('message', (d) => r1.push(JSON.parse(d.toString())))
    w2.on('message', (d) => r2.push(JSON.parse(d.toString())))

    await adapter.sendMessage({ chatId: 'ws-7', text: 'broadcast' })
    await new Promise((r) => setTimeout(r, 30))

    expect(r1).toHaveLength(1)
    expect(r2).toHaveLength(1)
    w1.close(); w2.close()
  })
})
```

- [ ] **Step 2: Implement sendMessage**

Replace the stub in `src/multi/channels/desktop.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import type { Message, ServerMessage } from '../chat/types.js'

// ...inside DesktopAdapter class...

async sendMessage(msg: OutboundMessage): Promise<SendResult> {
  const message: Message = {
    id: randomUUID(),
    role: 'assistant',
    text: msg.text,
    channel: 'desktop',
    createdAt: new Date().toISOString(),
  }
  const frame: ServerMessage = { type: 'message', message }
  this.broadcastToWorkspace(msg.chatId, frame)
  return {}
}

private broadcastToWorkspace(workspaceId: string, frame: ServerMessage): void {
  const payload = JSON.stringify(frame)
  for (const c of this.connections) {
    if (c.workspaceId !== workspaceId) continue
    if (c.socket.readyState === c.socket.OPEN) {
      try { c.socket.send(payload) } catch { /* peer gone, will close shortly */ }
    }
  }
}
```

- [ ] **Step 3: Run tests, expect PASS**

```bash
npx vitest run tests/multi/channels/desktop.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/multi/channels/desktop.ts tests/multi/channels/desktop.test.ts
git commit -m "feat(channels): DesktopAdapter outbound sendMessage + broadcast"
```

---

## Task 8: DesktopAdapter streaming — message-delta / message-final

**Files:**
- Modify: `src/multi/channels/desktop.ts`
- Modify: `tests/multi/channels/desktop.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('DesktopAdapter streamMessage', () => {
  let s: { port: number; close: () => Promise<void> }
  let adapter: DesktopAdapter

  beforeEach(async () => {
    adapter = new DesktopAdapter({ verifyJwt: () => ({ sub: 'ws-s' }) })
    s = await makeServer(adapter)
  })
  afterEach(async () => { await adapter.stop(); await s.close() })

  it('streams deltas then final', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const received: any[] = []
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))

    async function* gen() {
      yield 'Hel'
      yield 'Hello'
      yield 'Hello!'
    }
    await adapter.streamMessage({ chatId: 'ws-s', textStream: gen() })
    await new Promise((r) => setTimeout(r, 50))

    const deltas = received.filter((m) => m.type === 'message-delta')
    const finals = received.filter((m) => m.type === 'message-final')
    expect(deltas.length).toBeGreaterThanOrEqual(2)
    expect(finals).toHaveLength(1)
    expect(finals[0].text).toBe('Hello!')
    // All frames must share the same messageId
    const ids = new Set([...deltas, ...finals].map((m) => m.messageId))
    expect(ids.size).toBe(1)
    ws.close()
  })

  it('uses finalText override if provided', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const received: any[] = []
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))

    async function* gen() { yield 'A'; yield 'AB' }
    await adapter.streamMessage({ chatId: 'ws-s', textStream: gen(), finalText: 'OVERRIDE' })
    await new Promise((r) => setTimeout(r, 50))

    const final = received.find((m) => m.type === 'message-final')
    expect(final.text).toBe('OVERRIDE')
    ws.close()
  })
})
```

- [ ] **Step 2: Implement streamMessage**

Replace the stub in `src/multi/channels/desktop.ts`:

```typescript
async streamMessage(msg: StreamableOutbound): Promise<SendResult> {
  const messageId = randomUUID()
  let lastText = ''
  for await (const text of msg.textStream) {
    lastText = text
    this.broadcastToWorkspace(msg.chatId, {
      type: 'message-delta',
      messageId,
      text,
    })
  }
  const finalText = msg.finalText ?? lastText
  // finalTextOverride: if present and resolves to non-empty, use that
  let resolved = finalText
  if (msg.finalTextOverride) {
    try {
      const override = await Promise.race([
        msg.finalTextOverride,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ])
      if (typeof override === 'string' && override.length > 0) resolved = override
    } catch { /* keep finalText */ }
  }
  this.broadcastToWorkspace(msg.chatId, {
    type: 'message-final',
    messageId,
    text: resolved,
  })
  return {}
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run tests/multi/channels/desktop.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/multi/channels/desktop.ts tests/multi/channels/desktop.test.ts
git commit -m "feat(channels): DesktopAdapter streamMessage with delta/final frames"
```

---

## Task 9: OutboundDispatcher — cross-channel live mirror

**Files:**
- Create: `src/multi/channels/outbound-dispatcher.ts`
- Test: `tests/multi/channels/outbound-dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/multi/channels/outbound-dispatcher.test.ts
import { describe, expect, it, vi } from 'vitest'
import { OutboundDispatcher } from '../../../src/multi/channels/outbound-dispatcher.js'

function fakeDesktop() {
  const calls: any[] = []
  return {
    name: 'desktop' as const,
    mirror: vi.fn(async (workspaceId: string, message: any) => { calls.push({ workspaceId, message }) }),
    calls,
  }
}

describe('OutboundDispatcher', () => {
  it('forwards to all registered desktop adapters on primary != desktop', async () => {
    const d1 = fakeDesktop(); const d2 = fakeDesktop()
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerDesktop(d1 as any)
    dispatcher.registerDesktop(d2 as any)
    await dispatcher.afterPrimarySend({
      workspaceId: 'ws-A',
      primaryChannel: 'telegram',
      role: 'assistant',
      text: 'hi from TG',
    })
    expect(d1.mirror).toHaveBeenCalledOnce()
    expect(d2.mirror).toHaveBeenCalledOnce()
    expect(d1.calls[0].message.text).toBe('hi from TG')
    expect(d1.calls[0].message.channel).toBe('telegram')
  })

  it('does not mirror when primary == desktop (would echo)', async () => {
    const d = fakeDesktop()
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerDesktop(d as any)
    await dispatcher.afterPrimarySend({
      workspaceId: 'ws-A',
      primaryChannel: 'desktop',
      role: 'assistant',
      text: 'already in desktop',
    })
    expect(d.mirror).not.toHaveBeenCalled()
  })

  it('mirrors user-side messages too (so desktop sees outbound user activity from another channel)', async () => {
    const d = fakeDesktop()
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerDesktop(d as any)
    await dispatcher.afterPrimarySend({
      workspaceId: 'ws-A',
      primaryChannel: 'telegram',
      role: 'user',
      text: 'user typed in TG',
    })
    expect(d.mirror).toHaveBeenCalledOnce()
    expect(d.calls[0].message.role).toBe('user')
  })
})
```

- [ ] **Step 2: Implement OutboundDispatcher**

```typescript
// src/multi/channels/outbound-dispatcher.ts
import { randomUUID } from 'node:crypto'
import type { Message, MessageChannel, MessageRole } from '../chat/types.js'

export interface DesktopMirrorTarget {
  readonly name: 'desktop'
  mirror(workspaceId: string, message: Message): Promise<void>
}

export interface AfterPrimarySendInput {
  workspaceId: string
  primaryChannel: MessageChannel
  role: MessageRole
  text: string
}

/**
 * Single coordination point for cross-channel mirroring. When the engine
 * sends a message via Telegram (or any non-desktop primary channel), the
 * dispatcher echoes a `message-from-other-channel` frame into each
 * registered DesktopAdapter so the desktop UI stays in sync.
 *
 * Adapters don't know about each other — they only know about this
 * dispatcher. Telegram/Max never import DesktopAdapter.
 */
export class OutboundDispatcher {
  private desktops: DesktopMirrorTarget[] = []

  registerDesktop(target: DesktopMirrorTarget): void {
    this.desktops.push(target)
  }

  async afterPrimarySend(input: AfterPrimarySendInput): Promise<void> {
    if (input.primaryChannel === 'desktop') return // already in desktop; would echo
    const message: Message = {
      id: randomUUID(),
      role: input.role,
      text: input.text,
      channel: input.primaryChannel,
      createdAt: new Date().toISOString(),
    }
    await Promise.all(this.desktops.map((d) => d.mirror(input.workspaceId, message)))
  }
}
```

- [ ] **Step 3: Add `mirror` method to DesktopAdapter**

In `src/multi/channels/desktop.ts`, add:

```typescript
async mirror(workspaceId: string, message: Message): Promise<void> {
  this.broadcastToWorkspace(workspaceId, {
    type: 'message-from-other-channel',
    message,
  })
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/multi/channels/outbound-dispatcher.test.ts tests/multi/channels/desktop.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/multi/channels/outbound-dispatcher.ts src/multi/channels/desktop.ts tests/multi/channels/outbound-dispatcher.test.ts
git commit -m "feat(channels): OutboundDispatcher for cross-channel live mirror"
```

---

## Task 10: Wire DesktopAdapter + dispatcher in server.ts

**Files:**
- Modify: `src/multi/server.ts`
- Test: `tests/multi/server/desktop-wire.test.ts`

- [ ] **Step 1: Wire instantiation**

In `src/multi/server.ts`:

```typescript
import { DesktopAdapter } from './channels/desktop.js'
import { OutboundDispatcher } from './channels/outbound-dispatcher.js'
import { verifyJwt } from './auth/jwt.js'  // existing helper from P1.A

// alongside other channel constructions:
const desktopAdapter = new DesktopAdapter({
  verifyJwt: (token) => {
    const p = verifyJwt(token, env.BC_JWT_SECRET)
    return p ? { sub: p.sub as string } : null
  },
})
channels.desktop = desktopAdapter

const outboundDispatcher = new OutboundDispatcher()
outboundDispatcher.registerDesktop(desktopAdapter)

// Pass to runBetsyDeps so the engine can call dispatcher.afterPrimarySend
// after each outbound. Wire in Task 11.
runBetsyDeps.outboundDispatcher = outboundDispatcher

// Pass upgrade handler to startHealthzServer:
startHealthzServer(env.BC_HEALTHZ_PORT, pool, {
  extraRoutes: [...existingRoutes, historyRoute],
  upgrade: (req, socket, head) => desktopAdapter.handleUpgrade(req, socket, head),
})
```

If `channels` is typed with the existing partial record, the `'desktop'` key now type-checks because Task 1 added it to the union.

- [ ] **Step 2: Write integration test for wiring**

```typescript
// tests/multi/server/desktop-wire.test.ts
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'

// Minimal smoke against the published staging API. Gated env var lets the
// test run in CI against a real backend, otherwise it skips.
describe.skipIf(!process.env.BC_LIVE_TEST_URL)('desktop WS live wire', () => {
  it('rejects connection without JWT', async () => {
    const url = process.env.BC_LIVE_TEST_URL!.replace(/^http/, 'ws') + '/ws/chat'
    const ws = new WebSocket(url)
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c))
      ws.on('error', () => resolve(-1))
    })
    expect(code === 4001 || code === -1).toBe(true)
  })
})
```

- [ ] **Step 3: Run typecheck + tests**

```bash
npm run typecheck
npx vitest run tests/multi/server/
```

- [ ] **Step 4: Commit**

```bash
git add src/multi/server.ts tests/multi/server/desktop-wire.test.ts
git commit -m "feat(server): wire DesktopAdapter + OutboundDispatcher + WS upgrade route"
```

---

## Task 11: Hook OutboundDispatcher into runBetsy outbound flow

**Files:**
- Modify: `src/multi/agents/runner.ts` (or wherever channel.sendMessage gets called after agent reply)

- [ ] **Step 1: Locate channel.sendMessage call sites**

Grep to find all places where `channel.sendMessage(...)` or `channel.streamMessage(...)` is called in `src/multi/agents/` and `src/multi/bot-router/`. The two main paths are:
- `runBetsy(...)` → final assistant message dispatched to channel
- `runBetsyStream(...)` → streaming variant
- Bot router for user-typed-message echo (for live mirror of user messages)

- [ ] **Step 2: Inject dispatcher**

For each location:

```typescript
// after `await channel.sendMessage(msg)` or `await channel.streamMessage(msg)`:
if (deps.outboundDispatcher) {
  await deps.outboundDispatcher.afterPrimarySend({
    workspaceId: ws.id,
    primaryChannel: channel.name,
    role: 'assistant',
    text: finalAssistantText, // whatever variable holds the sent text
  })
}
```

For inbound user messages (so desktop sees TG-typed user messages live):

```typescript
// after a user message arrives via TG/Max and gets recorded:
if (deps.outboundDispatcher) {
  await deps.outboundDispatcher.afterPrimarySend({
    workspaceId: ws.id,
    primaryChannel: ev.channel,
    role: 'user',
    text: ev.text,
  })
}
```

- [ ] **Step 3: Update `runBetsyDeps` type**

In the file where `runBetsyDeps` interface lives (`src/multi/agents/runner.ts`), add:

```typescript
outboundDispatcher?: OutboundDispatcher
```

(Optional — fail-open if not wired, for tests.)

- [ ] **Step 4: Run typecheck + existing tests**

```bash
npm run typecheck
npx vitest run tests/multi/agents/
```

- [ ] **Step 5: Commit**

```bash
git add src/multi/agents/runner.ts src/multi/bot-router/router.ts
git commit -m "feat(agents): notify OutboundDispatcher after primary-channel sends"
```

---

## Task 12: deploy backend changes + smoke test live

**Files:** none (deployment)

- [ ] **Step 1: Local full-suite green**

```bash
npm run typecheck
BC_TEST_DATABASE_URL=$BC_TEST_DATABASE_URL npx vitest run
```

Expected: green.

- [ ] **Step 2: Build**

```bash
npm run build:all
```

- [ ] **Step 3: Deploy to VPS**

```bash
scp dist/index.js dist/index.js.map root@193.42.124.214:/tmp/p1-deploy/
ssh root@193.42.124.214 'cd /opt/betsy-multi && \
  TS=$(date +%s) && \
  cp dist/index.js dist/index.js.bak.$TS && \
  cp /tmp/p1-deploy/index.js dist/index.js && \
  cp /tmp/p1-deploy/index.js.map dist/index.js.map && \
  systemctl restart betsy-multi && \
  sleep 4 && \
  systemctl is-active betsy-multi'
```

- [ ] **Step 4: Smoke test from local**

```bash
# /catalog/personas still works (P1.A intact)
curl -sS https://api.betsyai.io/catalog/personas | head -c 200

# /chat/history requires JWT — should 401 without
curl -sSi https://api.betsyai.io/chat/history 2>&1 | head -5

# WS handshake without JWT should 4001/close
node -e "const WS = require('ws'); const w = new WS('wss://api.betsyai.io/ws/chat'); w.on('close', (c) => { console.log('close', c); process.exit(0); }); setTimeout(() => { console.log('timeout'); process.exit(1); }, 5000);"
```

Expected: catalog OK, history 401, WS closes 4001.

- [ ] **Step 5: Note in commit message + push**

Backend tasks 1–11 deployed. Pause; resume with frontend tasks.

---

## Task 13: Electron — BackendConnector real WS implementation

**Files:**
- Modify: `betsy-app/src/main/backend-connector.ts`
- Test: `betsy-app/tests/unit/backend-connector.test.ts`

The skeleton from P1.B has the file but not the real logic. Replace contents.

- [ ] **Step 1: Write the failing test**

```typescript
// betsy-app/tests/unit/backend-connector.test.ts
import { describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { BackendConnector } from '../../src/main/backend-connector.js'

function fakeServer() {
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  return new Promise<{ port: number; close: () => Promise<void>; wss: WebSocketServer }>((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port
      resolve({
        port, wss,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

describe('BackendConnector', () => {
  it('connects with Bearer header and emits open', async () => {
    const s = await fakeServer()
    let receivedAuth = ''
    s.wss.on('connection', (_ws, req) => {
      receivedAuth = req.headers.authorization ?? ''
    })

    const events: string[] = []
    const c = new BackendConnector({
      url: `ws://127.0.0.1:${s.port}/ws/chat`,
      jwt: 'tok-1',
    })
    c.on('open', () => events.push('open'))
    c.start()
    await new Promise((r) => setTimeout(r, 100))

    expect(receivedAuth).toBe('Bearer tok-1')
    expect(events).toContain('open')

    c.stop()
    await s.close()
  })

  it('emits message events for inbound JSON frames', async () => {
    const s = await fakeServer()
    s.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'pong' }))
    })
    const c = new BackendConnector({ url: `ws://127.0.0.1:${s.port}/ws/chat`, jwt: 'x' })
    const messages: any[] = []
    c.on('message', (m) => messages.push(m))
    c.start()
    await new Promise((r) => setTimeout(r, 100))
    expect(messages[0]).toEqual({ type: 'pong' })
    c.stop()
    await s.close()
  })

  it('reconnects on close with exponential backoff (capped)', async () => {
    const s = await fakeServer()
    let conns = 0
    s.wss.on('connection', (ws) => {
      conns++
      if (conns < 3) ws.close()  // refuse first two
    })
    const c = new BackendConnector({
      url: `ws://127.0.0.1:${s.port}/ws/chat`,
      jwt: 'x',
      backoffStartMs: 20,
      backoffMaxMs: 200,
    })
    c.start()
    await new Promise((r) => setTimeout(r, 800))
    expect(conns).toBeGreaterThanOrEqual(3)
    c.stop()
    await s.close()
  })

  it('emits closed-permanently with code 4001 on auth failure', async () => {
    const s = await fakeServer()
    s.wss.on('connection', (ws) => { ws.close(4001, 'auth_failed') })
    const c = new BackendConnector({ url: `ws://127.0.0.1:${s.port}/ws/chat`, jwt: 'x' })
    const events: any[] = []
    c.on('auth-failed', () => events.push('auth-failed'))
    c.start()
    await new Promise((r) => setTimeout(r, 200))
    expect(events).toContain('auth-failed')
    c.stop()
    await s.close()
  })

  it('send() forwards JSON to server', async () => {
    const s = await fakeServer()
    const received: any[] = []
    s.wss.on('connection', (ws) => {
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))
    })
    const c = new BackendConnector({ url: `ws://127.0.0.1:${s.port}/ws/chat`, jwt: 'x' })
    c.start()
    await new Promise((r) => setTimeout(r, 100))
    c.send({ type: 'ping' })
    await new Promise((r) => setTimeout(r, 50))
    expect(received).toEqual([{ type: 'ping' }])
    c.stop()
    await s.close()
  })
})
```

- [ ] **Step 2: Implement BackendConnector**

```typescript
// betsy-app/src/main/backend-connector.ts
import WebSocket from 'ws'
import { EventEmitter } from 'node:events'
import type { ClientMessage, ServerMessage } from '../shared/chat-protocol.js'

export interface BackendConnectorOptions {
  url: string                 // wss://api.betsyai.io/ws/chat
  jwt: string
  backoffStartMs?: number     // default 1000
  backoffMaxMs?: number       // default 30000
  pingIntervalMs?: number     // default 30000
}

/**
 * Persistent WS to the multi-server. Auto-reconnect with exponential backoff.
 * Emits:
 *   - 'open'           when connected
 *   - 'message'        (data: ServerMessage)   for any server frame
 *   - 'close'          on socket close (will reconnect unless auth-failed)
 *   - 'auth-failed'    on close 4001 — stops reconnecting; renderer should re-auth
 */
export class BackendConnector extends EventEmitter {
  private ws: WebSocket | null = null
  private alive = true
  private authFailed = false
  private currentBackoff: number
  private readonly maxBackoff: number
  private readonly pingInterval: number
  private pingTimer: NodeJS.Timeout | null = null

  constructor(private options: BackendConnectorOptions) {
    super()
    this.currentBackoff = options.backoffStartMs ?? 1000
    this.maxBackoff = options.backoffMaxMs ?? 30_000
    this.pingInterval = options.pingIntervalMs ?? 30_000
  }

  start(): void {
    this.alive = true
    this.authFailed = false
    this.connect()
  }

  stop(): void {
    this.alive = false
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    if (this.ws) {
      try { this.ws.close(1000, 'client-stop') } catch {}
    }
    this.ws = null
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  private connect(): void {
    if (this.authFailed || !this.alive) return
    const ws = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.jwt}` },
    })
    this.ws = ws
    ws.on('open', () => {
      this.currentBackoff = this.options.backoffStartMs ?? 1000
      this.emit('open')
      this.startPing()
    })
    ws.on('message', (raw) => {
      let parsed: ServerMessage
      try { parsed = JSON.parse(raw.toString()) }
      catch { return }
      this.emit('message', parsed)
    })
    ws.on('close', (code) => {
      this.stopPing()
      this.ws = null
      this.emit('close', code)
      if (code === 4001) {
        this.authFailed = true
        this.emit('auth-failed')
        return
      }
      if (this.alive) {
        const delay = this.currentBackoff
        this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoff)
        setTimeout(() => this.connect(), delay)
      }
    })
    ws.on('error', () => { /* covered by close */ })
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' })
      }
    }, this.pingInterval)
  }
  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }
}
```

- [ ] **Step 3: Run tests**

```bash
cd betsy-app && npx vitest run tests/unit/backend-connector.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add betsy-app/src/main/backend-connector.ts betsy-app/tests/unit/backend-connector.test.ts
git commit -m "feat(betsy-app): real BackendConnector with reconnect + auth-failed handling"
```

---

## Task 14: Electron — chat-history-client + IPC wiring

**Files:**
- Create: `betsy-app/src/main/chat-history-client.ts`
- Modify: `betsy-app/src/shared/ipc-contract.ts`
- Modify: `betsy-app/src/preload/preload.ts`
- Modify: `betsy-app/src/main/index.ts`
- Test: `betsy-app/tests/unit/chat-history-client.test.ts`

- [ ] **Step 1: Write chat-history-client + test**

```typescript
// betsy-app/src/main/chat-history-client.ts
import type { Message } from '../shared/chat-protocol.js'

export interface HistoryResponse { messages: Message[]; hasMore: boolean }

export class ChatHistoryClient {
  constructor(
    private apiBase: string,
    private jwt: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async fetchHistory(opts: { before?: string; limit?: number } = {}): Promise<HistoryResponse> {
    const url = new URL(`${this.apiBase}/chat/history`)
    if (opts.before) url.searchParams.set('before', opts.before)
    if (opts.limit) url.searchParams.set('limit', String(opts.limit))
    const res = await this.fetchFn(url.toString(), {
      headers: { authorization: `Bearer ${this.jwt}` },
    })
    if (res.status === 401) throw new Error('auth_failed')
    if (!res.ok) throw new Error(`history fetch failed: ${res.status}`)
    return await res.json()
  }
}
```

```typescript
// betsy-app/tests/unit/chat-history-client.test.ts
import { describe, expect, it, vi } from 'vitest'
import { ChatHistoryClient } from '../../src/main/chat-history-client.js'

describe('ChatHistoryClient', () => {
  it('fetches initial 50 with no cursor', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ messages: [], hasMore: false }),
    }) as any)
    const c = new ChatHistoryClient('https://api.test', 'jwt-1', fetchMock)
    await c.fetchHistory()
    const call = fetchMock.mock.calls[0]
    expect(call[0]).toBe('https://api.test/chat/history')
    expect(call[1].headers.authorization).toBe('Bearer jwt-1')
  })

  it('passes before + limit in query', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ messages: [], hasMore: false }),
    }) as any)
    const c = new ChatHistoryClient('https://api.test', 'jwt-1', fetchMock)
    await c.fetchHistory({ before: 'msg-9', limit: 25 })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/chat/history?before=msg-9&limit=25')
  })

  it('throws auth_failed on 401', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as any)
    const c = new ChatHistoryClient('https://api.test', 'bad', fetchMock)
    await expect(c.fetchHistory()).rejects.toThrow('auth_failed')
  })
})
```

- [ ] **Step 2: Run test, expect pass**

```bash
cd betsy-app && npx vitest run tests/unit/chat-history-client.test.ts
```

- [ ] **Step 3: Update IPC contract**

In `betsy-app/src/shared/ipc-contract.ts`, add:

```typescript
import type { Message, ClientMessage } from './chat-protocol.js'

export interface IpcContract {
  // ...existing P1 channels...
  'chat:send': (text: string) => Promise<void>          // text -> ClientMessage user-message
  'chat:history': (opts: { before?: string; limit?: number }) => Promise<{ messages: Message[]; hasMore: boolean }>
  'chat:start': () => Promise<void>                     // connect WS after wizard:done
  // Push events (main -> renderer):
  //   'chat:event' with ServerMessage payload
  //   'chat:connection' with { status: 'connecting' | 'open' | 'reconnecting' | 'auth-failed' }
}
```

- [ ] **Step 4: Update preload.ts**

In `betsy-app/src/preload/preload.ts`, add channel exposure for `chat:*` (likely the existing exposeInMainWorld already passes through `invoke(channel, ...args)` and `on(channel, cb)` generically — verify, no change needed if so).

- [ ] **Step 5: Wire IPC handlers in main/index.ts**

In `betsy-app/src/main/index.ts`, after `wizard:done` is dispatched (i.e., we have `jwt` + `workspaceId` from `hosted-auth`):

```typescript
import { BackendConnector } from './backend-connector.js'
import { ChatHistoryClient } from './chat-history-client.js'
import { ipcMain } from 'electron'

let connector: BackendConnector | null = null
let historyClient: ChatHistoryClient | null = null

function startChatBackend(apiBase: string, jwt: string, mainWindow: BrowserWindow): void {
  if (connector) connector.stop()
  const wsBase = apiBase.replace(/^http/, 'ws') + '/ws/chat'
  connector = new BackendConnector({ url: wsBase, jwt })
  historyClient = new ChatHistoryClient(apiBase, jwt)

  connector.on('open', () => mainWindow.webContents.send('chat:connection', { status: 'open' }))
  connector.on('close', () => mainWindow.webContents.send('chat:connection', { status: 'reconnecting' }))
  connector.on('auth-failed', () => mainWindow.webContents.send('chat:connection', { status: 'auth-failed' }))
  connector.on('message', (msg) => mainWindow.webContents.send('chat:event', msg))

  connector.start()
}

ipcMain.handle('chat:send', async (_e, text: string) => {
  if (!connector) throw new Error('chat-not-started')
  const clientMessageId = crypto.randomUUID()
  connector.send({ type: 'user-message', text, clientMessageId })
})

ipcMain.handle('chat:history', async (_e, opts: { before?: string; limit?: number }) => {
  if (!historyClient) throw new Error('chat-not-started')
  return historyClient.fetchHistory(opts)
})

// Call startChatBackend(apiBase, hostedJwt, mainWindow) at the existing
// place where wizard:done dispatches.
```

- [ ] **Step 6: Commit**

```bash
git add betsy-app/src/main/chat-history-client.ts betsy-app/src/shared/ipc-contract.ts \
       betsy-app/src/main/index.ts betsy-app/tests/unit/chat-history-client.test.ts
git commit -m "feat(betsy-app): chat history client + IPC wiring for renderer"
```

---

## Task 15: useChat hook (renderer state machine)

**Files:**
- Create: `betsy-app/src/renderer/chat/useChat.ts`
- Test: `betsy-app/tests/unit/use-chat.test.ts`

- [ ] **Step 1: Write the hook**

```typescript
// betsy-app/src/renderer/chat/useChat.ts
import { useEffect, useReducer, useRef } from 'react'
import type { Message, ServerMessage } from '../../shared/chat-protocol.js'

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'auth-failed'

interface State {
  messages: Message[]               // ascending by createdAt
  streaming: Record<string, string> // messageId -> current text (during delta phase)
  hasMore: boolean
  status: ConnectionStatus
  typing: boolean
}

type Action =
  | { kind: 'history-loaded'; messages: Message[]; hasMore: boolean; prepend?: boolean }
  | { kind: 'message-arrived'; message: Message }
  | { kind: 'message-delta'; messageId: string; text: string }
  | { kind: 'message-final'; messageId: string; text: string }
  | { kind: 'message-from-other-channel'; message: Message }
  | { kind: 'typing'; on: boolean }
  | { kind: 'connection'; status: ConnectionStatus }
  | { kind: 'optimistic-user'; message: Message }

const initial: State = {
  messages: [], streaming: {}, hasMore: false, status: 'connecting', typing: false,
}

function reducer(s: State, a: Action): State {
  switch (a.kind) {
    case 'history-loaded': {
      const incoming = a.messages.slice().sort((x, y) => x.createdAt.localeCompare(y.createdAt))
      return a.prepend
        ? { ...s, messages: [...incoming, ...s.messages], hasMore: a.hasMore }
        : { ...s, messages: incoming, hasMore: a.hasMore }
    }
    case 'message-arrived':
    case 'message-from-other-channel': {
      const exists = s.messages.find((m) => m.id === a.message.id)
      if (exists) return s
      return { ...s, messages: [...s.messages, a.message] }
    }
    case 'message-delta':
      return { ...s, streaming: { ...s.streaming, [a.messageId]: a.text } }
    case 'message-final': {
      const { [a.messageId]: _omit, ...rest } = s.streaming
      const finalMsg: Message = {
        id: a.messageId, role: 'assistant', text: a.text, channel: 'desktop',
        createdAt: new Date().toISOString(),
      }
      const exists = s.messages.find((m) => m.id === a.messageId)
      return {
        ...s,
        streaming: rest,
        messages: exists ? s.messages.map((m) => (m.id === a.messageId ? finalMsg : m)) : [...s.messages, finalMsg],
      }
    }
    case 'typing':
      return { ...s, typing: a.on }
    case 'connection':
      return { ...s, status: a.status }
    case 'optimistic-user':
      return { ...s, messages: [...s.messages, a.message] }
  }
}

export function useChat() {
  const [state, dispatch] = useReducer(reducer, initial)
  const cursorRef = useRef<string | null>(null)

  useEffect(() => {
    // Wire IPC subscriptions
    const offEvent = window.api.on('chat:event', (msg: ServerMessage) => {
      switch (msg.type) {
        case 'history-batch':
          dispatch({ kind: 'history-loaded', messages: msg.messages, hasMore: msg.hasMore })
          cursorRef.current = msg.messages.at(0)?.id ?? null
          break
        case 'message': dispatch({ kind: 'message-arrived', message: msg.message }); break
        case 'message-delta': dispatch({ kind: 'message-delta', messageId: msg.messageId, text: msg.text }); break
        case 'message-final': dispatch({ kind: 'message-final', messageId: msg.messageId, text: msg.text }); break
        case 'message-from-other-channel':
          dispatch({ kind: 'message-from-other-channel', message: msg.message }); break
        case 'typing': dispatch({ kind: 'typing', on: msg.on }); break
        case 'pong': break
        case 'error': console.warn('chat error', msg); break
      }
    })
    const offConn = window.api.on('chat:connection', (s: { status: ConnectionStatus }) => {
      dispatch({ kind: 'connection', status: s.status })
    })

    // Initial history fetch + start WS connection
    void (async () => {
      try {
        const r = await window.api.invoke('chat:history', { limit: 50 })
        dispatch({ kind: 'history-loaded', messages: r.messages, hasMore: r.hasMore })
        cursorRef.current = r.messages.at(0)?.id ?? null
      } catch (e) { console.warn('initial history failed', e) }
    })()

    return () => { offEvent(); offConn() }
  }, [])

  async function send(text: string): Promise<void> {
    const optimistic: Message = {
      id: `tmp-${Date.now()}`,
      role: 'user',
      text,
      channel: 'desktop',
      createdAt: new Date().toISOString(),
    }
    dispatch({ kind: 'optimistic-user', message: optimistic })
    await window.api.invoke('chat:send', text)
  }

  async function loadOlder(): Promise<void> {
    if (!state.hasMore || !cursorRef.current) return
    const r = await window.api.invoke('chat:history', { before: cursorRef.current, limit: 50 })
    dispatch({ kind: 'history-loaded', messages: r.messages, hasMore: r.hasMore, prepend: true })
    cursorRef.current = r.messages.at(0)?.id ?? cursorRef.current
  }

  return { state, send, loadOlder }
}
```

- [ ] **Step 2: Write reducer-only test (avoid React Testing Library)**

```typescript
// betsy-app/tests/unit/use-chat.test.ts
import { describe, expect, it } from 'vitest'
// Extract the reducer in a way tests can import it; cleanest:
// re-export from useChat.ts. Or duplicate in a test-friendly module.
// For now, test the public flow via a thin extracted reducer.

// In useChat.ts make the reducer + initial state exported separately:
//   export const _initial = initial
//   export const _reducer = reducer
//
// Then test:
import { _initial, _reducer } from '../../src/renderer/chat/useChat.js'

describe('useChat reducer', () => {
  it('history-loaded sets messages ascending', () => {
    const s = _reducer(_initial, {
      kind: 'history-loaded',
      messages: [
        { id: 'b', role: 'user', text: 'B', channel: 'desktop', createdAt: '2026-05-24T10:01:00Z' },
        { id: 'a', role: 'user', text: 'A', channel: 'desktop', createdAt: '2026-05-24T10:00:00Z' },
      ],
      hasMore: false,
    })
    expect(s.messages.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('message-delta tracks streaming text per id', () => {
    let s = _reducer(_initial, { kind: 'message-delta', messageId: 'm1', text: 'He' })
    s = _reducer(s, { kind: 'message-delta', messageId: 'm1', text: 'Hello' })
    expect(s.streaming['m1']).toBe('Hello')
  })

  it('message-final clears streaming and inserts final message', () => {
    let s = _reducer(_initial, { kind: 'message-delta', messageId: 'm1', text: 'partial' })
    s = _reducer(s, { kind: 'message-final', messageId: 'm1', text: 'final text' })
    expect(s.streaming['m1']).toBeUndefined()
    expect(s.messages.find((m) => m.id === 'm1')?.text).toBe('final text')
  })

  it('history prepend keeps order: older first', () => {
    let s = _reducer(_initial, {
      kind: 'history-loaded',
      messages: [{ id: 'b', role: 'user', text: 'B', channel: 'desktop', createdAt: '2026-05-24T10:01:00Z' }],
      hasMore: true,
    })
    s = _reducer(s, {
      kind: 'history-loaded',
      messages: [{ id: 'a', role: 'user', text: 'A', channel: 'desktop', createdAt: '2026-05-24T10:00:00Z' }],
      hasMore: false,
      prepend: true,
    })
    expect(s.messages.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('deduplicates message-arrived by id', () => {
    const msg = { id: 'x', role: 'assistant' as const, text: 'hi', channel: 'desktop' as const, createdAt: 'z' }
    let s = _reducer(_initial, { kind: 'message-arrived', message: msg })
    s = _reducer(s, { kind: 'message-arrived', message: msg })
    expect(s.messages).toHaveLength(1)
  })
})
```

In `useChat.ts` add at the bottom: `export { initial as _initial, reducer as _reducer }`.

- [ ] **Step 3: Run tests**

```bash
cd betsy-app && npx vitest run tests/unit/use-chat.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add betsy-app/src/renderer/chat/useChat.ts betsy-app/tests/unit/use-chat.test.ts
git commit -m "feat(chat-ui): useChat hook with reducer (history, streaming, optimistic send)"
```

---

## Task 16: Chat UI components

**Files:**
- Create: `betsy-app/src/renderer/chat/AvatarHeader.tsx`
- Create: `betsy-app/src/renderer/chat/MessageList.tsx`
- Create: `betsy-app/src/renderer/chat/Composer.tsx`
- Create: `betsy-app/src/renderer/chat/ChatWindow.tsx`
- Create: `betsy-app/src/renderer/chat/ReAuthBanner.tsx`
- Delete: `betsy-app/src/renderer/chat/DeferredChatPlaceholder.tsx`
- Modify: `betsy-app/src/renderer/App.tsx`

- [ ] **Step 1: AvatarHeader**

```tsx
// betsy-app/src/renderer/chat/AvatarHeader.tsx
import type { ConnectionStatus } from './useChat.js'

export function AvatarHeader({
  personaName, avatarUrl, status,
}: { personaName: string; avatarUrl: string | null; status: ConnectionStatus }) {
  const statusColor = status === 'open' ? '#10b981' : status === 'auth-failed' ? '#ef4444' : '#fbbf24'
  const statusLabel = status === 'open' ? 'онлайн' : status === 'auth-failed' ? 'сессия истекла' : 'переподключаюсь…'
  return (
    <header className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800 bg-neutral-950">
      {avatarUrl ? (
        <img src={`file://${avatarUrl}`} alt="" className="w-8 h-8 rounded-full object-cover" />
      ) : (
        <div className="w-8 h-8 rounded-full bg-neutral-700" />
      )}
      <div className="flex-1">
        <div className="text-sm font-medium text-neutral-200">{personaName}</div>
        <div className="text-xs flex items-center gap-1.5" style={{ color: statusColor }}>
          <span>●</span><span>{statusLabel}</span>
        </div>
      </div>
    </header>
  )
}
```

- [ ] **Step 2: MessageList**

```tsx
// betsy-app/src/renderer/chat/MessageList.tsx
import { useEffect, useRef } from 'react'
import type { Message } from '../../shared/chat-protocol.js'

interface Props {
  messages: Message[]
  streaming: Record<string, string>
  onScrollTop?: () => void
}

export function MessageList({ messages, streaming, onScrollTop }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new message (only if user was near the bottom).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    if (e.currentTarget.scrollTop < 50 && onScrollTop) onScrollTop()
  }

  return (
    <div ref={containerRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
      {messages.map((m) => {
        const text = streaming[m.id] ?? m.text
        const isUser = m.role === 'user'
        return (
          <div key={m.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[70%] px-3.5 py-2.5 rounded-2xl text-[13.5px] ${
              isUser ? 'bg-blue-600 text-white rounded-br-md' : 'bg-neutral-800 text-neutral-100 rounded-bl-md'
            }`}>
              {text}
              {streaming[m.id] !== undefined && (
                <span className="inline-block w-2 h-3 bg-emerald-400 ml-1 animate-pulse" />
              )}
              <div className={`text-[10.5px] mt-1 ${isUser ? 'text-blue-100' : 'text-neutral-500'}`}>
                {new Date(m.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                {m.channel !== 'desktop' && <span className="ml-1.5">· {m.channel === 'telegram' ? 'TG' : m.channel}</span>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: Composer**

```tsx
// betsy-app/src/renderer/chat/Composer.tsx
import { useState, KeyboardEvent } from 'react'

export function Composer({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) {
  const [text, setText] = useState('')
  function submit() {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }
  return (
    <div className="border-t border-neutral-800 bg-neutral-950 p-3 flex items-end gap-2">
      <textarea
        className="flex-1 bg-neutral-900 text-neutral-100 text-sm rounded-2xl px-3.5 py-2 resize-none max-h-32 outline-none focus:ring-1 focus:ring-blue-600"
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder={disabled ? 'Подключаюсь…' : 'Напиши сообщение…'}
        disabled={disabled}
      />
      <button
        onClick={submit}
        disabled={!text.trim() || disabled}
        className="w-9 h-9 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white flex items-center justify-center"
      >▶</button>
    </div>
  )
}
```

- [ ] **Step 4: ReAuthBanner**

```tsx
// betsy-app/src/renderer/chat/ReAuthBanner.tsx
export function ReAuthBanner({ onReauth }: { onReauth: () => void }) {
  return (
    <div className="p-8 text-center max-w-md mx-auto">
      <h2 className="text-xl mb-3 text-neutral-100">Сессия истекла</h2>
      <p className="text-neutral-400 mb-4">Открой Бетси заново — это переподключит чат.</p>
      <button
        onClick={onReauth}
        className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg"
      >Войти заново</button>
    </div>
  )
}
```

- [ ] **Step 5: ChatWindow**

```tsx
// betsy-app/src/renderer/chat/ChatWindow.tsx
import { AvatarHeader } from './AvatarHeader.js'
import { MessageList } from './MessageList.js'
import { Composer } from './Composer.js'
import { ReAuthBanner } from './ReAuthBanner.js'
import { useChat } from './useChat.js'

export function ChatWindow({
  personaName, avatarUrl, onReauth,
}: { personaName: string; avatarUrl: string | null; onReauth: () => void }) {
  const { state, send, loadOlder } = useChat()
  if (state.status === 'auth-failed') return <ReAuthBanner onReauth={onReauth} />

  return (
    <div className="h-screen flex flex-col bg-neutral-950">
      <AvatarHeader personaName={personaName} avatarUrl={avatarUrl} status={state.status} />
      <MessageList messages={state.messages} streaming={state.streaming} onScrollTop={loadOlder} />
      <Composer onSend={send} disabled={state.status !== 'open'} />
    </div>
  )
}
```

- [ ] **Step 6: Update App.tsx**

In `betsy-app/src/renderer/App.tsx`, replace the `<DeferredChatPlaceholder />` import + render at the `wizard:done` step with:

```tsx
import { ChatWindow } from './chat/ChatWindow.js'
// ...
if (state.step === 'done') {
  const preset = presets.find((p) => p.id === state.selectedPresetId)
  return <ChatWindow
    personaName={preset?.name ?? 'Бетси'}
    avatarUrl={avatarPaths[state.selectedPresetId ?? ''] ?? null}
    onReauth={async () => {
      await api.invoke('wizard:dispatch', { type: 'reset' })
      const next = await api.invoke('wizard:getState')
      setState(next)
    }}
  />
}
```

Also call `await api.invoke('chat:start')` once when state.step transitions to 'done', so main process knows to start the WS connection (if not already auto-triggered after wizard).

- [ ] **Step 7: Delete placeholder**

```bash
rm betsy-app/src/renderer/chat/DeferredChatPlaceholder.tsx
```

- [ ] **Step 8: Run typecheck + tests + build**

```bash
cd betsy-app && npx tsc --noEmit -p tsconfig.renderer.json && npm test && npm run build && cd ..
```

- [ ] **Step 9: Commit**

```bash
git add betsy-app/src/renderer/chat/ betsy-app/src/renderer/App.tsx
git rm betsy-app/src/renderer/chat/DeferredChatPlaceholder.tsx
git commit -m "feat(chat-ui): ChatWindow + MessageList + Composer + ReAuthBanner; remove placeholder"
```

---

## Task 17: E2E test — full hosted chat happy path

**Files:**
- Create: `betsy-app/tests/e2e/desktop-chat.test.ts`
- Modify: `betsy-app/tests/e2e/helpers/mock-backend.ts` (extend to mock chat endpoints)

- [ ] **Step 1: Extend mock-backend**

Open `betsy-app/tests/e2e/helpers/mock-backend.ts` from P1.B. Add to the existing `startMockBackend` function:

```typescript
import { WebSocketServer } from 'ws'

export interface MockBackendOptions { enableChatWs?: boolean }

export async function startMockBackend(opts: MockBackendOptions = {}): Promise<MockBackend> {
  // ...existing HTTP server creation...

  // History endpoint
  // Add inside the existing createServer((req, res) => { ... }) router:
  if (req.method === 'GET' && url.pathname === '/chat/history') {
    if (!(req.headers.authorization ?? '').startsWith('Bearer ')) {
      res.statusCode = 401; res.end('{}'); return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ messages: [], hasMore: false }))
    return
  }

  // WS chat (only if requested)
  let wss: WebSocketServer | null = null
  if (opts.enableChatWs) {
    wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      if (!(req.url ?? '').startsWith('/ws/chat')) { socket.destroy(); return }
      wss!.handleUpgrade(req, socket, head, (ws) => {
        // Mock: send empty history on connect, then accept user-message and
        // stream back a canned reply.
        ws.send(JSON.stringify({ type: 'history-batch', messages: [], hasMore: false }))
        ws.on('message', (raw) => {
          let msg: any
          try { msg = JSON.parse(raw.toString()) } catch { return }
          if (msg.type === 'user-message') {
            const messageId = 'm-' + Date.now()
            const chunks = ['ок', 'окей', 'окей, понял.']
            ;(async () => {
              for (const c of chunks) {
                await new Promise((r) => setTimeout(r, 30))
                ws.send(JSON.stringify({ type: 'message-delta', messageId, text: c }))
              }
              ws.send(JSON.stringify({ type: 'message-final', messageId, text: 'окей, понял.' }))
            })()
          } else if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }))
          }
        })
      })
    })
  }

  return {
    url, close: async () => { wss?.close(); /* ...existing close logic... */ },
    simulateTelegramStart: () => { /* existing */ },
  }
}
```

The exact integration with the existing `mock-backend.ts` (where to splice each block) is up to the executor — but the WS path, message types, and chunk pattern above must match what the test in Step 2 asserts.

- [ ] **Step 2: E2E test**

```typescript
// betsy-app/tests/e2e/desktop-chat.test.ts
import { test, expect } from '@playwright/test'
import { startMockBackend, type MockBackend } from './helpers/mock-backend.js'
import { launch } from './helpers/electron-driver.js'

let backend: MockBackend
test.beforeEach(async () => { backend = await startMockBackend({ enableChatWs: true }) })
test.afterEach(async () => { await backend.close() })

test('after wizard done: chat window opens, send works, streaming reply visible', async () => {
  const { app, window } = await launch({
    BC_API_BASE: backend.url,
    BETSY_E2E: '1',
  })

  // Walk through hosted wizard quickly (helper already covers it):
  await window.locator('button:has-text("Бетси")').first().click()
  await window.locator('button:has-text("Хостим у нас")').click()
  await window.locator('button:has-text("Войти через Telegram")').click()
  backend.simulateTelegramStart()

  // Chat window should appear
  await expect(window.locator('[placeholder*="Напиши"]')).toBeVisible({ timeout: 10_000 })

  // Send a message
  await window.locator('[placeholder*="Напиши"]').fill('тест-пишу-бетси')
  await window.locator('button:has-text("▶")').click()

  // User bubble appears (optimistic)
  await expect(window.locator('text=тест-пишу-бетси')).toBeVisible()

  // Streaming reply from mock backend arrives
  await expect(window.locator('text=окей')).toBeVisible({ timeout: 5_000 })

  await app.close()
})
```

- [ ] **Step 3: Run e2e**

```bash
cd betsy-app && npx playwright test desktop-chat.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add betsy-app/tests/e2e/desktop-chat.test.ts betsy-app/tests/e2e/helpers/mock-backend.ts
git commit -m "test(betsy-app): e2e desktop chat happy path through mock backend"
```

---

## Task 18: Release rc — full backend + Electron in one tag

- [ ] **Step 1: Bump betsy-app version**

```bash
cd betsy-app && npm version 0.2.0-rc1 --no-git-tag-version && cd ..
```

- [ ] **Step 2: Commit + tag**

```bash
git add betsy-app/package.json
git commit -m "chore(release): bump to 0.2.0-rc1"
git push origin main
git tag app-v0.2.0-rc1 -m "rc1 of desktop channel"
git push origin app-v0.2.0-rc1
```

- [ ] **Step 3: Watch CI**

```bash
gh run watch $(gh run list --workflow=release-app.yml --repo Aimagine-life/Betsy --limit 1 --json databaseId -q '.[0].databaseId') --repo Aimagine-life/Betsy --exit-status
```

Expected: green; installer at `https://updates.betsyai.io/electron/win-x64/Betsy-Setup-latest.exe`.

- [ ] **Step 4: Smoke install on Windows**

Download installer on a clean Windows VM, install, complete wizard, write to Бетси in the desktop chat window. Reply should stream into the bubble.

---

## Final checks

- [ ] All unit tests green: `npx vitest run` (root + betsy-app)
- [ ] Typecheck clean (root + each tsconfig in betsy-app)
- [ ] Build green: `npm run build:all` + `cd betsy-app && npm run build`
- [ ] Backend deployed to VPS: `/healthz`, `/catalog/personas`, `/chat/history` 401 without JWT, `/ws/chat` 4001 without JWT
- [ ] CI release succeeds, installer downloadable
- [ ] Manual smoke: install + wizard + chat + streaming response

---

## Notes for executor

- `verifyJwt` from `src/multi/auth/jwt.ts` (existing P1.A helper) returns `null | { sub, exp, ... }`. Use it directly; no need to write new auth code.
- WS upgrade flow: `startHealthzServer({ upgrade })` sets `server.on('upgrade', ...)` once. If you find a way to register multiple upgrade handlers (e.g., multiple WS paths), don't bother for P1.5 — one handler that dispatches by path is fine.
- `OutboundDispatcher` is intentionally hookless to Telegram/Max — they don't import it. Only `runBetsy*` and the bot router import it.
- `tsup` will bundle everything into `dist/index.js`. The new `src/multi/chat/` directory is auto-picked-up.
- After Task 12 you've deployed backend. Frontend tasks 13–17 can be developed locally against the live `api.betsyai.io` for manual checks, mock backend for tests.
- Persona avatar URL on desktop window: `persona-cache` (P1.B) gives a local file path for the static avatar. Pass through `App.tsx` → `ChatWindow` props.
- If `wizard:done` happens but `chat:start` never fires (e.g., race), expose `chat:start` as a renderer-callable IPC and call it explicitly from `App.tsx` when transitioning to `'done'`.
- React 18 + `useReducer` re-renders on each dispatch — for very fast streaming (10+ deltas/sec) consider throttling delta dispatches with `requestAnimationFrame`. Defer until visible regression.
- Live mirror echoes user-typed-in-TG messages into desktop too — that's intentional, see spec section 7.
