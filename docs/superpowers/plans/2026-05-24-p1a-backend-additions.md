# P1.A — Backend Additions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add backend pieces required for P1 Distribution Shell: persona-preset catalog, Telegram deep-link login (nonce + poll), and `/start <nonce>` bot handler that creates a workspace bound to the chosen preset.

**Architecture:** Static built-in `PersonaPreset` catalog in code (no per-workspace state). Three new HTTP endpoints in `src/multi/server.ts`: `/catalog/personas`, `/auth/tg-link/start`, `/auth/tg-link/poll`. One new Postgres table `bc_tg_link_nonces`. Hook into existing `bot-router` for `/start <nonce>` handling. Workspace creation already exists (`WorkspaceRepo.upsertForTelegram`) — we extend the flow to copy preset → workspace persona.

**Tech Stack:** TypeScript (ESM), Postgres + RLS via `withWorkspace`/`asAdmin`, vitest. Spec: [docs/superpowers/specs/2026-05-24-distribution-shell-p1-design.md](../specs/2026-05-24-distribution-shell-p1-design.md).

---

## File Structure

### New files
- `src/multi/personas/preset-types.ts` — `PersonaPreset` interface (avatar, wizardLines, defaults)
- `src/multi/personas/presets.ts` — static array of 2 built-in presets + `getPreset(id)` lookup
- `src/multi/personas/presets-schema.ts` — zod schema validation (run at module load)
- `src/multi/auth/tg-link-types.ts` — `TgLinkNonce`, `TgLinkResult` types
- `src/multi/auth/tg-link-repo.ts` — Postgres repo for nonces (create, find, complete, sweep)
- `src/multi/auth/tg-link-service.ts` — business logic: start, poll, complete
- `src/multi/db/migrations/014_tg_link_nonces.sql` — table for nonces

### Modified files
- `src/multi/server.ts` — register 3 new endpoints
- `src/multi/bot-router/router.ts` (or wherever `/start` is dispatched) — detect nonce in `/start` payload, route to `tg-link-service.complete`
- `src/multi/workspaces/repo.ts` — no changes if `upsertForTelegram` + `updatePersonaId` enough; otherwise add `createFromTelegramLogin(tgId, presetId)`

### New test files
- `tests/multi/personas/presets.test.ts`
- `tests/multi/auth/tg-link-repo.test.ts` (integration — gated on `BC_TEST_DATABASE_URL`)
- `tests/multi/auth/tg-link-service.test.ts` (unit, mocks)
- `tests/multi/server/catalog-personas.test.ts` (integration)
- `tests/multi/server/auth-tg-link.test.ts` (integration)
- `tests/multi/bot-router/tg-link-start.test.ts` (integration)
- `tests/multi/e2e/tg-link-flow.test.ts` (full happy path)

---

## Task 1: PersonaPreset type and zod schema

**Files:**
- Create: `src/multi/personas/preset-types.ts`
- Create: `src/multi/personas/presets-schema.ts`
- Test: `tests/multi/personas/presets.test.ts`

- [ ] **Step 1: Create the type file**

```typescript
// src/multi/personas/preset-types.ts
import type { BehaviorConfig } from './types.js'

export interface PersonaPresetAvatar {
  /** URL to a static image (CDN). Served to Windows-app for wizard + main window. */
  static: string
  /** Optional short voice sample for preview in persona picker. */
  voiceSample?: string
}

export interface PersonaPresetWizardLines {
  mode_intro: string
  mode_hosted_pitch?: string
  mode_selfhost_checklist: string[]
  mode_selfhost_hint: string

  tg_login_intro: string
  tg_login_waiting: string
  tg_login_success: string

  ssh_prompt: string
  ssh_test_ok: string
  install_progress: string
  install_done: string
  bot_token_prompt: string
  bot_webhook_ok: string

  wizard_complete: string
}

export interface PersonaPreset {
  id: string
  name: string
  gender: string | null
  voiceId: string
  defaultBehavior: BehaviorConfig
  biography: string
  defaultPersonalityPrompt: string
  avatar: PersonaPresetAvatar
  wizardLines: PersonaPresetWizardLines
}
```

- [ ] **Step 2: Create the zod schema**

```typescript
// src/multi/personas/presets-schema.ts
import { z } from 'zod'

const behaviorConfigSchema = z.object({
  voice: z.enum(['text_only', 'voice_on_reply', 'voice_always', 'auto']),
  selfie: z.enum(['never', 'on_request', 'special_moments', 'auto']),
  video: z.enum(['never', 'on_request', 'auto']),
})

const avatarSchema = z.object({
  static: z.string().url(),
  voiceSample: z.string().url().optional(),
})

const wizardLinesSchema = z.object({
  mode_intro: z.string().min(1),
  mode_hosted_pitch: z.string().optional(),
  mode_selfhost_checklist: z.array(z.string().min(1)).min(1),
  mode_selfhost_hint: z.string().min(1),

  tg_login_intro: z.string().min(1),
  tg_login_waiting: z.string().min(1),
  tg_login_success: z.string().min(1),

  ssh_prompt: z.string().min(1),
  ssh_test_ok: z.string().min(1),
  install_progress: z.string().min(1),
  install_done: z.string().min(1),
  bot_token_prompt: z.string().min(1),
  bot_webhook_ok: z.string().min(1),

  wizard_complete: z.string().min(1),
})

export const personaPresetSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be kebab-case'),
  name: z.string().min(1),
  gender: z.string().nullable(),
  voiceId: z.string().min(1),
  defaultBehavior: behaviorConfigSchema,
  biography: z.string().min(1),
  defaultPersonalityPrompt: z.string().min(1),
  avatar: avatarSchema,
  wizardLines: wizardLinesSchema,
})

export const personaPresetsArraySchema = z.array(personaPresetSchema)
```

- [ ] **Step 3: Commit**

```bash
git add src/multi/personas/preset-types.ts src/multi/personas/presets-schema.ts
git commit -m "feat(personas): add PersonaPreset type and zod schema"
```

---

## Task 2: Static presets catalog

**Files:**
- Create: `src/multi/personas/presets.ts`
- Test: `tests/multi/personas/presets.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/multi/personas/presets.test.ts
import { describe, expect, it } from 'vitest'
import { BUILTIN_PRESETS, getPreset, listPresets } from '../../../src/multi/personas/presets.js'
import { personaPresetsArraySchema } from '../../../src/multi/personas/presets-schema.ts'

describe('persona presets', () => {
  it('exposes at least 2 built-in presets', () => {
    expect(BUILTIN_PRESETS.length).toBeGreaterThanOrEqual(2)
  })

  it('all presets pass zod schema', () => {
    expect(() => personaPresetsArraySchema.parse(BUILTIN_PRESETS)).not.toThrow()
  })

  it('preset ids are unique', () => {
    const ids = BUILTIN_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('includes betsy-default and betsy-pro', () => {
    expect(getPreset('betsy-default')).toBeDefined()
    expect(getPreset('betsy-pro')).toBeDefined()
  })

  it('getPreset returns null for unknown id', () => {
    expect(getPreset('nonexistent')).toBeNull()
  })

  it('listPresets returns a snapshot, not a reference', () => {
    const list = listPresets()
    expect(list).toEqual(BUILTIN_PRESETS)
    list.length = 0
    expect(BUILTIN_PRESETS.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run tests/multi/personas/presets.test.ts
```

Expected: FAIL with "Cannot find module '.../presets.js'"

- [ ] **Step 3: Create presets module**

```typescript
// src/multi/personas/presets.ts
import { personaPresetsArraySchema } from './presets-schema.js'
import type { PersonaPreset } from './preset-types.js'

const RAW_PRESETS: PersonaPreset[] = [
  {
    id: 'betsy-default',
    name: 'Бетси',
    gender: 'female',
    voiceId: 'Aoede',
    defaultBehavior: { voice: 'auto', selfie: 'on_request', video: 'on_request' },
    biography:
      'Тёплый универсальный помощник. Подходит, если ты впервые ставишь AI-ассистента.',
    defaultPersonalityPrompt:
      'Ты Бетси — тёплый и внимательный AI-ассистент. Отвечаешь по-человечески, без канцелярита.',
    avatar: {
      static: 'https://cdn.betsyai.io/presets/betsy-default/avatar.webp',
    },
    wizardLines: {
      mode_intro: 'Окей! Теперь определимся, где я буду жить.',
      mode_hosted_pitch: 'Если хочешь без забот — выбирай подписку.',
      mode_selfhost_checklist: [
        'VPS (Hetzner, DigitalOcean, любой другой)',
        'SSH-доступ (root или sudo)',
        'Docker на VPS — поставлю сама, если нет',
        'Свой бот в @BotFather',
      ],
      mode_selfhost_hint:
        'Если ничего из правого списка пока нет — выбирай левое, всё проще будет.',
      tg_login_intro: 'Открою тебе мой чат в Telegram — нажми Start, и я к тебе привяжусь.',
      tg_login_waiting: 'Жду тебя в чате — нажми Start.',
      tg_login_success: 'Привязалась. Спасибо!',
      ssh_prompt:
        'Подключусь к серверу. Дай SSH-доступ — я сама всё поставлю.',
      ssh_test_ok: 'Сервер вижу. Иду ставиться.',
      install_progress: 'Качаю и запускаю Docker-контейнеры…',
      install_done: 'Готово, я на сервере. Осталось дать мне бота.',
      bot_token_prompt:
        'Открой @BotFather, создай бот, вставь токен сюда — я пропишу webhook сама.',
      bot_webhook_ok: 'Бот подключен.',
      wizard_complete: 'Готово! Напиши мне в Telegram, чтобы начать.',
    },
  },
  {
    id: 'betsy-pro',
    name: 'Бетси Pro',
    gender: 'female',
    voiceId: 'Kore',
    defaultBehavior: { voice: 'voice_on_reply', selfie: 'on_request', video: 'on_request' },
    biography:
      'Деловой помощник для работы и проектов. Сжато, по делу, без лишнего.',
    defaultPersonalityPrompt:
      'Ты Бетси Pro — деловой AI-ассистент. Отвечаешь сжато и по делу, без воды.',
    avatar: {
      static: 'https://cdn.betsyai.io/presets/betsy-pro/avatar.webp',
    },
    wizardLines: {
      mode_intro: 'Где разворачиваем — у нас или на твоём VPS?',
      mode_selfhost_checklist: [
        'VPS с root SSH',
        'Docker (либо поставлю сама)',
        'Бот в @BotFather',
      ],
      mode_selfhost_hint: 'Если ничего нет — бери подписку.',
      tg_login_intro: 'Открываю Telegram. Нажми Start — привяжемся.',
      tg_login_waiting: 'Жду /start.',
      tg_login_success: 'Привязан.',
      ssh_prompt: 'Введи SSH-доступ к VPS.',
      ssh_test_ok: 'Сервер доступен.',
      install_progress: 'Разворачиваю Docker-стек.',
      install_done: 'Готово. Теперь токен бота.',
      bot_token_prompt: 'Создай бота у @BotFather. Вставь токен.',
      bot_webhook_ok: 'Webhook прописан.',
      wizard_complete: 'Готово. Пиши в Telegram.',
    },
  },
]

// Validate at module load — fail fast on bad data
personaPresetsArraySchema.parse(RAW_PRESETS)

export const BUILTIN_PRESETS: ReadonlyArray<PersonaPreset> = Object.freeze(RAW_PRESETS)

export function getPreset(id: string): PersonaPreset | null {
  return BUILTIN_PRESETS.find((p) => p.id === id) ?? null
}

export function listPresets(): PersonaPreset[] {
  return [...BUILTIN_PRESETS]
}
```

- [ ] **Step 4: Run tests, verify all pass**

```bash
npx vitest run tests/multi/personas/presets.test.ts
```

Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/multi/personas/presets.ts tests/multi/personas/presets.test.ts
git commit -m "feat(personas): add static catalog with 2 built-in presets"
```

---

## Task 3: GET /catalog/personas endpoint

**Files:**
- Modify: `src/multi/server.ts` (add route handler)
- Test: `tests/multi/server/catalog-personas.test.ts`

- [ ] **Step 1: Locate existing route registration in `src/multi/server.ts`**

Find the HTTP routing block. Use Grep:

```bash
# (use Grep tool, not bash)
# pattern: "function createApp|registerRoutes|app.get|server.on"
# path: src/multi/server.ts
```

Read the surrounding 60 lines so you understand how routes are registered (express, fastify, raw http, etc.). The rest of this task uses placeholder `register('GET', '/catalog/personas', handler)` — adapt to actual style.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/multi/server/catalog-personas.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer } from '../helpers/test-server.js' // existing helper, or use server module directly

describe('GET /catalog/personas', () => {
  let server: { url: string; close: () => Promise<void> }

  beforeAll(async () => {
    server = await createTestServer()
  })
  afterAll(async () => {
    await server.close()
  })

  it('returns array of presets without auth', async () => {
    const res = await fetch(`${server.url}/catalog/personas`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(2)
  })

  it('each preset has id, name, avatar, wizardLines', () => {
    return fetch(`${server.url}/catalog/personas`)
      .then((r) => r.json())
      .then((body: any[]) => {
        for (const p of body) {
          expect(typeof p.id).toBe('string')
          expect(typeof p.name).toBe('string')
          expect(typeof p.avatar.static).toBe('string')
          expect(typeof p.wizardLines.mode_intro).toBe('string')
        }
      })
  })

  it('sets cache-control for 5 minutes', async () => {
    const res = await fetch(`${server.url}/catalog/personas`)
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d+/)
  })
})
```

If `tests/multi/helpers/test-server.ts` doesn't exist, check existing integration tests for the pattern (look in `tests/multi/server/` if directory exists, or `tests/multi/sim/`).

- [ ] **Step 3: Run, expect fail**

```bash
npx vitest run tests/multi/server/catalog-personas.test.ts
```

Expected: FAIL — endpoint not found (404)

- [ ] **Step 4: Add the handler**

```typescript
// src/multi/server.ts — inside route registration block
import { listPresets } from './personas/presets.js'

// ...

// public catalog — no auth required
register('GET', '/catalog/personas', async (_req, res) => {
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'public, max-age=300') // 5 min
  res.end(JSON.stringify(listPresets()))
})
```

If the server uses Express:
```typescript
app.get('/catalog/personas', (_req, res) => {
  res.set('cache-control', 'public, max-age=300').json(listPresets())
})
```

If raw `node:http` (the project uses raw http per CLAUDE.md): find the existing `requestHandler` switch on `req.url + req.method` and add a case.

- [ ] **Step 5: Run test, expect pass**

```bash
npx vitest run tests/multi/server/catalog-personas.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/multi/server.ts tests/multi/server/catalog-personas.test.ts
git commit -m "feat(server): GET /catalog/personas — public preset catalog"
```

---

## Task 4: `bc_tg_link_nonces` migration

**Files:**
- Create: `src/multi/db/migrations/014_tg_link_nonces.sql`

- [ ] **Step 1: Write the migration**

```sql
-- src/multi/db/migrations/014_tg_link_nonces.sql

create table if not exists bc_tg_link_nonces (
  nonce            text primary key,
  preset_id        text not null,
  expires_at       timestamptz not null,
  -- completion fields, null until /start <nonce> arrives
  workspace_id     uuid references workspaces(id) on delete cascade,
  jwt              text,
  completed_at     timestamptz,
  -- bookkeeping
  created_at       timestamptz not null default now(),
  used             boolean not null default false
);

create index if not exists bc_tg_link_nonces_expires_idx on bc_tg_link_nonces(expires_at);
create index if not exists bc_tg_link_nonces_completed_idx on bc_tg_link_nonces(completed_at)
  where completed_at is not null;

-- Bypasses RLS — accessed only via asAdmin (target user doesn't have workspace_id yet)
alter table bc_tg_link_nonces enable row level security;
alter table bc_tg_link_nonces force row level security;

-- Defensive policy for any future withWorkspace call (e.g. cleanup of completed link)
drop policy if exists ws_scoped on bc_tg_link_nonces;
create policy ws_scoped on bc_tg_link_nonces
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

grant select, insert, update, delete on bc_tg_link_nonces to bc_app;
```

- [ ] **Step 2: Run migration locally**

```bash
npm run migrate  # or whatever exists; check package.json scripts
```

If no migration runner exists yet, find how migrations are applied. The project has `src/multi/db/migrate.ts` — read it to confirm.

- [ ] **Step 3: Verify table exists**

```bash
psql $BC_DATABASE_URL -c "\d bc_tg_link_nonces"
```

Expected: shows the new table with 8 columns and indices.

- [ ] **Step 4: Commit**

```bash
git add src/multi/db/migrations/014_tg_link_nonces.sql
git commit -m "feat(db): migration 014 — bc_tg_link_nonces table"
```

---

## Task 5: TgLink types and repo

**Files:**
- Create: `src/multi/auth/tg-link-types.ts`
- Create: `src/multi/auth/tg-link-repo.ts`
- Test: `tests/multi/auth/tg-link-repo.test.ts`

- [ ] **Step 1: Create types**

```typescript
// src/multi/auth/tg-link-types.ts
export interface TgLinkNonce {
  nonce: string
  presetId: string
  expiresAt: Date
  workspaceId: string | null
  jwt: string | null
  completedAt: Date | null
  createdAt: Date
  used: boolean
}

/** Returned by service when nonce is completed (user pressed /start). */
export interface TgLinkResult {
  jwt: string
  workspaceId: string
}
```

- [ ] **Step 2: Write the failing repo test**

```typescript
// tests/multi/auth/tg-link-repo.test.ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { TgLinkRepo } from '../../../src/multi/auth/tg-link-repo.js'

const BC_TEST_DATABASE_URL = process.env.BC_TEST_DATABASE_URL

describe.skipIf(!BC_TEST_DATABASE_URL)('TgLinkRepo', () => {
  let pool: Pool
  let repo: TgLinkRepo

  beforeAll(() => {
    pool = new Pool({ connectionString: BC_TEST_DATABASE_URL })
    repo = new TgLinkRepo(pool)
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('truncate bc_tg_link_nonces')
  })

  it('creates a nonce with 5 min expiry', async () => {
    const before = Date.now()
    const n = await repo.create('abc-123', 'betsy-default')
    expect(n.nonce).toBe('abc-123')
    expect(n.presetId).toBe('betsy-default')
    expect(n.expiresAt.getTime()).toBeGreaterThan(before + 4 * 60_000)
    expect(n.completedAt).toBeNull()
    expect(n.used).toBe(false)
  })

  it('findActive returns nonce if not expired or used', async () => {
    await repo.create('n1', 'betsy-pro')
    const found = await repo.findActive('n1')
    expect(found?.presetId).toBe('betsy-pro')
  })

  it('findActive returns null for unknown nonce', async () => {
    const found = await repo.findActive('does-not-exist')
    expect(found).toBeNull()
  })

  it('findActive returns null for used nonce', async () => {
    await repo.create('n2', 'betsy-default')
    await repo.markUsed('n2')
    expect(await repo.findActive('n2')).toBeNull()
  })

  it('complete sets workspace_id + jwt + completed_at + used', async () => {
    await repo.create('n3', 'betsy-default')
    // need a real workspace id; create via raw insert
    const { rows } = await pool.query(
      `insert into workspaces (owner_tg_id) values (888001) returning id`,
    )
    const wsId = rows[0].id
    await repo.complete('n3', wsId, 'fake-jwt-xyz')
    const after = await repo.findById('n3')
    expect(after?.workspaceId).toBe(wsId)
    expect(after?.jwt).toBe('fake-jwt-xyz')
    expect(after?.completedAt).toBeInstanceOf(Date)
    expect(after?.used).toBe(true)
  })

  it('sweepExpired deletes nonces past expires_at', async () => {
    await pool.query(
      `insert into bc_tg_link_nonces (nonce, preset_id, expires_at)
       values ('expired-1', 'betsy-default', now() - interval '1 hour')`,
    )
    const deleted = await repo.sweepExpired()
    expect(deleted).toBe(1)
    expect(await repo.findActive('expired-1')).toBeNull()
  })
})
```

- [ ] **Step 3: Implement the repo**

```typescript
// src/multi/auth/tg-link-repo.ts
import type { Pool } from 'pg'
import { asAdmin } from '../db/rls.js'
import type { TgLinkNonce } from './tg-link-types.js'

function rowToNonce(r: any): TgLinkNonce {
  return {
    nonce: r.nonce,
    presetId: r.preset_id,
    expiresAt: r.expires_at,
    workspaceId: r.workspace_id,
    jwt: r.jwt,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    used: r.used,
  }
}

const NONCE_TTL_MS = 5 * 60_000

export class TgLinkRepo {
  constructor(private pool: Pool) {}

  async create(nonce: string, presetId: string): Promise<TgLinkNonce> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `insert into bc_tg_link_nonces (nonce, preset_id, expires_at)
         values ($1, $2, now() + interval '5 minutes')
         returning *`,
        [nonce, presetId],
      )
      return rowToNonce(rows[0])
    })
  }

  async findById(nonce: string): Promise<TgLinkNonce | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select * from bc_tg_link_nonces where nonce = $1`,
        [nonce],
      )
      return rows[0] ? rowToNonce(rows[0]) : null
    })
  }

  /** Returns nonce only if it exists, is not used, and is not expired. */
  async findActive(nonce: string): Promise<TgLinkNonce | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select * from bc_tg_link_nonces
         where nonce = $1 and used = false and expires_at > now()`,
        [nonce],
      )
      return rows[0] ? rowToNonce(rows[0]) : null
    })
  }

  async markUsed(nonce: string): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update bc_tg_link_nonces set used = true where nonce = $1`,
        [nonce],
      )
    })
  }

  async complete(nonce: string, workspaceId: string, jwt: string): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update bc_tg_link_nonces
         set workspace_id = $2, jwt = $3, completed_at = now(), used = true
         where nonce = $1`,
        [nonce, workspaceId, jwt],
      )
    })
  }

  async sweepExpired(): Promise<number> {
    return asAdmin(this.pool, async (client) => {
      const { rowCount } = await client.query(
        `delete from bc_tg_link_nonces where expires_at < now()`,
      )
      return rowCount ?? 0
    })
  }
}
```

- [ ] **Step 4: Run tests against test DB**

```bash
BC_TEST_DATABASE_URL=$BC_TEST_DATABASE_URL npx vitest run tests/multi/auth/tg-link-repo.test.ts
```

Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/multi/auth/tg-link-types.ts src/multi/auth/tg-link-repo.ts tests/multi/auth/tg-link-repo.test.ts
git commit -m "feat(auth): TgLinkRepo for nonces + integration tests"
```

---

## Task 6: TgLinkService

**Files:**
- Create: `src/multi/auth/tg-link-service.ts`
- Test: `tests/multi/auth/tg-link-service.test.ts`

The service is the business-logic layer between HTTP handlers / bot handler and the repo. It is responsible for: generating UUIDv4 nonces, validating presetId, building deep links, polling for completion, JWT minting.

- [ ] **Step 1: Find existing JWT helper**

```bash
# Use Grep: search for "jwt" in src/multi/
# patterns: "jwt.sign", "signJwt", "createJwt", "node:crypto"
```

Per CLAUDE.md, the project does JWT HS256 via `node:crypto`, no library. Find the helper (probably `src/multi/auth/jwt.ts` or in `src/server.ts`). Reuse it.

If no helper exists, document this in the task by reading `src/server.ts` JWT block and extract to `src/multi/auth/jwt.ts` as a separate sub-step **before** continuing.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/multi/auth/tg-link-service.test.ts
import { describe, expect, it, vi } from 'vitest'
import { TgLinkService } from '../../../src/multi/auth/tg-link-service.js'

function makeMockRepo() {
  const created: any[] = []
  return {
    storage: created,
    repo: {
      create: vi.fn(async (n: string, p: string) => {
        const row = { nonce: n, presetId: p, expiresAt: new Date(Date.now() + 5 * 60_000), workspaceId: null, jwt: null, completedAt: null, createdAt: new Date(), used: false }
        created.push(row)
        return row
      }),
      findById: vi.fn(async (n: string) => created.find((c) => c.nonce === n) ?? null),
      findActive: vi.fn(async (n: string) => created.find((c) => c.nonce === n && !c.used) ?? null),
      complete: vi.fn(async (n: string, ws: string, jwt: string) => {
        const row = created.find((c) => c.nonce === n)
        if (row) {
          row.workspaceId = ws
          row.jwt = jwt
          row.completedAt = new Date()
          row.used = true
        }
      }),
      markUsed: vi.fn(),
      sweepExpired: vi.fn(),
    },
  }
}

describe('TgLinkService', () => {
  it('start() generates a uuid nonce and returns deep link', async () => {
    const { repo } = makeMockRepo()
    const svc = new TgLinkService(repo as any, {
      botUsername: 'betsyai_bot',
      jwtSecret: 'test-secret',
    })
    const result = await svc.start('betsy-default')
    expect(result.nonce).toMatch(/^[0-9a-f-]{36}$/i)
    expect(result.deepLink).toBe(`https://t.me/betsyai_bot?start=${result.nonce}`)
    expect(repo.create).toHaveBeenCalledWith(result.nonce, 'betsy-default')
  })

  it('start() rejects unknown preset id', async () => {
    const { repo } = makeMockRepo()
    const svc = new TgLinkService(repo as any, { botUsername: 'betsyai_bot', jwtSecret: 's' })
    await expect(svc.start('unknown-preset')).rejects.toThrow(/unknown preset/i)
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('poll() returns null while nonce not completed', async () => {
    const { repo, storage } = makeMockRepo()
    storage.push({ nonce: 'n1', presetId: 'betsy-default', completedAt: null, workspaceId: null, jwt: null, used: false, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() })
    const svc = new TgLinkService(repo as any, { botUsername: 'betsyai_bot', jwtSecret: 's' })
    expect(await svc.poll('n1')).toBeNull()
  })

  it('poll() returns {jwt, workspaceId} when completed', async () => {
    const { repo, storage } = makeMockRepo()
    storage.push({ nonce: 'n2', presetId: 'betsy-default', completedAt: new Date(), workspaceId: 'ws-1', jwt: 'jwt-xyz', used: true, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() })
    const svc = new TgLinkService(repo as any, { botUsername: 'betsyai_bot', jwtSecret: 's' })
    const r = await svc.poll('n2')
    expect(r).toEqual({ jwt: 'jwt-xyz', workspaceId: 'ws-1' })
  })

  it('complete() mints jwt for given workspace and stores in repo', async () => {
    const { repo } = makeMockRepo()
    await repo.create('n3', 'betsy-default')
    const svc = new TgLinkService(repo as any, { botUsername: 'betsyai_bot', jwtSecret: 'secret' })
    const out = await svc.complete('n3', 'ws-abc')
    expect(out.workspaceId).toBe('ws-abc')
    expect(out.jwt).toBeTypeOf('string')
    expect(out.jwt.length).toBeGreaterThan(20)
    expect(repo.complete).toHaveBeenCalledWith('n3', 'ws-abc', out.jwt)
  })

  it('complete() throws if nonce is not active', async () => {
    const { repo } = makeMockRepo()
    const svc = new TgLinkService(repo as any, { botUsername: 'betsyai_bot', jwtSecret: 's' })
    await expect(svc.complete('missing', 'ws-x')).rejects.toThrow(/not active|expired|unknown/i)
  })
})
```

- [ ] **Step 3: Implement service**

```typescript
// src/multi/auth/tg-link-service.ts
import { randomUUID } from 'node:crypto'
import { getPreset } from '../personas/presets.js'
import { signJwt } from './jwt.js' // adjust path to JWT helper found in Step 1
import type { TgLinkRepo } from './tg-link-repo.js'
import type { TgLinkResult } from './tg-link-types.js'

export interface TgLinkServiceConfig {
  /** Bot username without @ (e.g. "betsyai_bot") */
  botUsername: string
  /** Secret for HS256 JWT */
  jwtSecret: string
  /** JWT validity in seconds. Default 60 days. */
  jwtTtlSeconds?: number
}

export interface TgLinkStartResult {
  nonce: string
  deepLink: string
  expiresIn: number  // seconds until nonce expires
}

export class TgLinkService {
  constructor(
    private repo: TgLinkRepo,
    private config: TgLinkServiceConfig,
  ) {}

  async start(presetId: string): Promise<TgLinkStartResult> {
    if (!getPreset(presetId)) {
      throw new Error(`unknown preset: ${presetId}`)
    }
    const nonce = randomUUID()
    await this.repo.create(nonce, presetId)
    return {
      nonce,
      deepLink: `https://t.me/${this.config.botUsername}?start=${nonce}`,
      expiresIn: 5 * 60,
    }
  }

  /** Returns {jwt, workspaceId} if completed, null if still pending. */
  async poll(nonce: string): Promise<TgLinkResult | null> {
    const row = await this.repo.findById(nonce)
    if (!row || !row.completedAt || !row.jwt || !row.workspaceId) return null
    return { jwt: row.jwt, workspaceId: row.workspaceId }
  }

  /**
   * Called by the bot handler on `/start <nonce>`. Mints JWT for the workspace
   * and stores it on the nonce row. Returns the JWT + workspaceId so the bot
   * handler can send a confirmation message containing the persona name.
   */
  async complete(nonce: string, workspaceId: string): Promise<TgLinkResult> {
    const active = await this.repo.findActive(nonce)
    if (!active) {
      throw new Error(`nonce not active: ${nonce}`)
    }
    const ttl = this.config.jwtTtlSeconds ?? 60 * 60 * 24 * 60
    const jwt = signJwt({ sub: workspaceId, type: 'tg-link' }, this.config.jwtSecret, ttl)
    await this.repo.complete(nonce, workspaceId, jwt)
    return { jwt, workspaceId }
  }

  /** Read presetId out of an active nonce. Used by bot handler to know which preset to apply. */
  async getPresetId(nonce: string): Promise<string | null> {
    const active = await this.repo.findActive(nonce)
    return active?.presetId ?? null
  }
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npx vitest run tests/multi/auth/tg-link-service.test.ts
```

Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/multi/auth/tg-link-service.ts tests/multi/auth/tg-link-service.test.ts
git commit -m "feat(auth): TgLinkService for nonce lifecycle and JWT minting"
```

---

## Task 7: POST /auth/tg-link/start endpoint

**Files:**
- Modify: `src/multi/server.ts`
- Test: `tests/multi/server/auth-tg-link.test.ts`

- [ ] **Step 1: Locate the server wiring** — find where `WorkspaceRepo`, etc. are constructed in `server.ts`. Add `TgLinkRepo` and `TgLinkService` to the same wiring block. Environment variables: `BC_TG_BOT_USERNAME`, `BC_JWT_SECRET` (probably already exist).

- [ ] **Step 2: Write the failing test (start endpoint)**

```typescript
// tests/multi/server/auth-tg-link.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createTestServer } from '../helpers/test-server.js'

const BC_TEST_DATABASE_URL = process.env.BC_TEST_DATABASE_URL

describe.skipIf(!BC_TEST_DATABASE_URL)('POST /auth/tg-link/start', () => {
  let server: { url: string; close: () => Promise<void> }
  let pool: Pool

  beforeAll(async () => {
    server = await createTestServer()
    pool = new Pool({ connectionString: BC_TEST_DATABASE_URL })
  })
  afterAll(async () => {
    await server.close()
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('truncate bc_tg_link_nonces')
  })

  it('returns nonce + deepLink for valid preset', async () => {
    const res = await fetch(`${server.url}/auth/tg-link/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId: 'betsy-default' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.nonce).toMatch(/^[0-9a-f-]{36}$/i)
    expect(body.deepLink).toMatch(/^https:\/\/t\.me\/.+\?start=/)
    expect(body.expiresIn).toBe(300)
  })

  it('rejects unknown preset id with 400', async () => {
    const res = await fetch(`${server.url}/auth/tg-link/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId: 'nope-no-no' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects missing presetId with 400', async () => {
    const res = await fetch(`${server.url}/auth/tg-link/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 3: Run, expect fail**

```bash
BC_TEST_DATABASE_URL=$BC_TEST_DATABASE_URL npx vitest run tests/multi/server/auth-tg-link.test.ts
```

Expected: FAIL — 404

- [ ] **Step 4: Wire the service and add handler**

In `src/multi/server.ts` initialization block:

```typescript
import { TgLinkRepo } from './auth/tg-link-repo.js'
import { TgLinkService } from './auth/tg-link-service.js'

// during app construction (alongside WorkspaceRepo, etc.):
const tgLinkRepo = new TgLinkRepo(pool)
const tgLinkService = new TgLinkService(tgLinkRepo, {
  botUsername: process.env.BC_TG_BOT_USERNAME!,
  jwtSecret: process.env.BC_JWT_SECRET!,
})
```

Add route handler (adapt syntax to project style):

```typescript
register('POST', '/auth/tg-link/start', async (req, res) => {
  const body = await readJsonBody(req)
  if (!body || typeof body.presetId !== 'string') {
    return sendJson(res, 400, { error: 'presetId required' })
  }
  try {
    const result = await tgLinkService.start(body.presetId)
    return sendJson(res, 200, result)
  } catch (e: any) {
    if (e.message.startsWith('unknown preset')) {
      return sendJson(res, 400, { error: e.message })
    }
    throw e
  }
})
```

`readJsonBody` and `sendJson` — find existing helpers in `src/multi/server.ts` (they almost certainly exist for other endpoints).

- [ ] **Step 5: Run test, expect pass**

```bash
BC_TEST_DATABASE_URL=$BC_TEST_DATABASE_URL npx vitest run tests/multi/server/auth-tg-link.test.ts
```

Expected: PASS (3 tests for /start)

- [ ] **Step 6: Commit**

```bash
git add src/multi/server.ts tests/multi/server/auth-tg-link.test.ts
git commit -m "feat(server): POST /auth/tg-link/start"
```

---

## Task 8: GET /auth/tg-link/poll endpoint (long-poll)

**Files:**
- Modify: `src/multi/server.ts`
- Test: extend `tests/multi/server/auth-tg-link.test.ts`

The poll endpoint long-polls up to 60 seconds. On each second it checks `service.poll(nonce)`. Returns 200 with `{jwt, workspaceId}` on success, 408 on timeout, 404 on unknown nonce.

- [ ] **Step 1: Write the failing tests**

Add to the existing `auth-tg-link.test.ts`:

```typescript
describe.skipIf(!BC_TEST_DATABASE_URL)('GET /auth/tg-link/poll', () => {
  let server: { url: string; close: () => Promise<void> }
  let pool: Pool

  beforeAll(async () => {
    server = await createTestServer()
    pool = new Pool({ connectionString: BC_TEST_DATABASE_URL })
  })
  afterAll(async () => {
    await server.close()
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('truncate bc_tg_link_nonces')
  })

  it('returns 404 for unknown nonce', async () => {
    const res = await fetch(`${server.url}/auth/tg-link/poll?nonce=does-not-exist&maxWaitMs=100`)
    expect(res.status).toBe(404)
  })

  it('returns 408 if nonce exists but not completed within maxWaitMs', async () => {
    // create nonce
    const startRes = await fetch(`${server.url}/auth/tg-link/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId: 'betsy-default' }),
    })
    const { nonce } = await startRes.json()

    const res = await fetch(`${server.url}/auth/tg-link/poll?nonce=${nonce}&maxWaitMs=300`)
    expect(res.status).toBe(408)
  })

  it('returns 200 + token when nonce is completed during poll', async () => {
    // start
    const startRes = await fetch(`${server.url}/auth/tg-link/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId: 'betsy-default' }),
    })
    const { nonce } = await startRes.json()

    // create real workspace + manually mark complete after 200ms
    const { rows } = await pool.query(
      `insert into workspaces (owner_tg_id) values (777001) returning id`,
    )
    const wsId = rows[0].id

    setTimeout(() => {
      pool.query(
        `update bc_tg_link_nonces
         set workspace_id = $1, jwt = $2, completed_at = now(), used = true
         where nonce = $3`,
        [wsId, 'fake-jwt-from-test', nonce],
      )
    }, 200)

    const res = await fetch(`${server.url}/auth/tg-link/poll?nonce=${nonce}&maxWaitMs=2000`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.jwt).toBe('fake-jwt-from-test')
    expect(body.workspaceId).toBe(wsId)
  })
})
```

- [ ] **Step 2: Run, expect fail**

```bash
BC_TEST_DATABASE_URL=$BC_TEST_DATABASE_URL npx vitest run tests/multi/server/auth-tg-link.test.ts
```

Expected: 3 new FAIL (404 because endpoint missing)

- [ ] **Step 3: Implement the handler**

```typescript
register('GET', '/auth/tg-link/poll', async (req, res) => {
  const url = new URL(req.url ?? '', 'http://x')
  const nonce = url.searchParams.get('nonce')
  if (!nonce) return sendJson(res, 400, { error: 'nonce required' })

  // existence check — bail fast on unknown
  const exists = await tgLinkRepo.findById(nonce)
  if (!exists) return sendJson(res, 404, { error: 'nonce not found' })

  const maxWait = Math.min(parseInt(url.searchParams.get('maxWaitMs') ?? '60000', 10), 60_000)
  const startedAt = Date.now()

  while (Date.now() - startedAt < maxWait) {
    const result = await tgLinkService.poll(nonce)
    if (result) return sendJson(res, 200, result)
    await new Promise((r) => setTimeout(r, 500))
  }
  return sendJson(res, 408, { error: 'timeout' })
})
```

- [ ] **Step 4: Run, expect pass**

```bash
BC_TEST_DATABASE_URL=$BC_TEST_DATABASE_URL npx vitest run tests/multi/server/auth-tg-link.test.ts
```

Expected: PASS (6 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/multi/server.ts tests/multi/server/auth-tg-link.test.ts
git commit -m "feat(server): GET /auth/tg-link/poll long-poll endpoint"
```

---

## Task 9: createWorkspaceFromTelegramLogin in WorkspaceRepo

**Files:**
- Modify: `src/multi/workspaces/repo.ts`
- Test: `tests/multi/workspaces/repo.test.ts` (extend if exists; otherwise create)

This method wraps `upsertForTelegram + create Persona from preset + updatePersonaId` in a single transaction.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/multi/workspaces/repo.test.ts (add or extend)
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { PersonaRepo } from '../../../src/multi/personas/repo.js'
import { getPreset } from '../../../src/multi/personas/presets.js'

const BC_TEST_DATABASE_URL = process.env.BC_TEST_DATABASE_URL

describe.skipIf(!BC_TEST_DATABASE_URL)('WorkspaceRepo.createFromTelegramLogin', () => {
  let pool: Pool
  let workspaces: WorkspaceRepo
  let personas: PersonaRepo

  beforeAll(() => {
    pool = new Pool({ connectionString: BC_TEST_DATABASE_URL })
    workspaces = new WorkspaceRepo(pool)
    personas = new PersonaRepo(pool)
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query(`delete from workspaces where owner_tg_id in (555001, 555002)`)
  })

  it('creates workspace + persona from preset, links persona_id', async () => {
    const ws = await workspaces.createFromTelegramLogin(555001, 'betsy-default', personas)
    expect(ws.ownerTgId).toBe(555001)
    expect(ws.personaId).not.toBeNull()
    const persona = await personas.findById(ws.id, ws.personaId!)
    expect(persona).not.toBeNull()
    const preset = getPreset('betsy-default')!
    expect(persona!.name).toBe(preset.name)
    expect(persona!.voiceId).toBe(preset.voiceId)
    expect(persona!.personalityPrompt).toBe(preset.defaultPersonalityPrompt)
  })

  it('idempotent — second call returns existing workspace, does not create extra persona', async () => {
    const ws1 = await workspaces.createFromTelegramLogin(555002, 'betsy-default', personas)
    const ws2 = await workspaces.createFromTelegramLogin(555002, 'betsy-pro', personas)
    expect(ws1.id).toBe(ws2.id)
    // persona id should remain whatever was set on first call (don't switch presets on re-login)
    expect(ws2.personaId).toBe(ws1.personaId)
  })

  it('throws on unknown preset', async () => {
    await expect(
      workspaces.createFromTelegramLogin(555001, 'unknown-preset', personas),
    ).rejects.toThrow(/unknown preset/i)
  })
})
```

- [ ] **Step 2: Implement the method**

In `src/multi/workspaces/repo.ts` add:

```typescript
import { getPreset } from '../personas/presets.js'
import type { PersonaRepo } from '../personas/repo.js'

// inside WorkspaceRepo class:

async createFromTelegramLogin(
  tgId: number,
  presetId: string,
  personas: PersonaRepo,
): Promise<Workspace> {
  const preset = getPreset(presetId)
  if (!preset) throw new Error(`unknown preset: ${presetId}`)

  // Idempotent: if workspace already exists for this tg user, do not create a new persona
  const existing = await this.findByTelegram(tgId)
  if (existing && existing.personaId) return existing

  const ws = await this.upsertForTelegram(tgId)

  if (!ws.personaId) {
    const persona = await personas.create(ws.id, {
      presetId: preset.id,
      name: preset.name,
      gender: preset.gender,
      voiceId: preset.voiceId,
      personalityPrompt: preset.defaultPersonalityPrompt,
      biography: preset.biography,
      behaviorConfig: preset.defaultBehavior,
    })
    await this.updatePersonaId(ws.id, persona.id)
    return (await this.findById(ws.id))!
  }
  return ws
}
```

- [ ] **Step 3: Run, expect pass**

```bash
BC_TEST_DATABASE_URL=$BC_TEST_DATABASE_URL npx vitest run tests/multi/workspaces/repo.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 4: Commit**

```bash
git add src/multi/workspaces/repo.ts tests/multi/workspaces/repo.test.ts
git commit -m "feat(workspaces): createFromTelegramLogin — preset → persona → link"
```

---

## Task 10: Bot `/start <nonce>` handler

**Files:**
- Modify: `src/multi/bot-router/router.ts` (or wherever `/start` is currently dispatched)
- Test: `tests/multi/bot-router/tg-link-start.test.ts`

- [ ] **Step 1: Locate current `/start` handling**

```bash
# Use Grep:
# pattern: "/start" or "'start'" or "case 'start'"
# path: src/multi/bot-router/
```

Read the file. Understand how a `/start <payload>` update is parsed and dispatched.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/multi/bot-router/tg-link-start.test.ts
import { describe, expect, it, vi } from 'vitest'
import { handleStartCommand } from '../../../src/multi/bot-router/router.js' // adjust name

describe('/start <nonce> handler', () => {
  it('completes nonce + creates workspace when nonce is active', async () => {
    const completeFn = vi.fn(async () => ({ jwt: 'jwt-x', workspaceId: 'ws-1' }))
    const getPresetIdFn = vi.fn(async () => 'betsy-default')
    const createFromTgFn = vi.fn(async () => ({ id: 'ws-1', ownerTgId: 12345, personaId: 'p-1' }))
    const sendMessageFn = vi.fn()

    await handleStartCommand(
      { tgUserId: 12345, payload: 'abc-nonce-123' },
      {
        tgLinkService: { getPresetId: getPresetIdFn, complete: completeFn } as any,
        workspaces: { createFromTelegramLogin: createFromTgFn } as any,
        personas: {} as any,
        sendMessage: sendMessageFn,
      },
    )

    expect(getPresetIdFn).toHaveBeenCalledWith('abc-nonce-123')
    expect(createFromTgFn).toHaveBeenCalledWith(12345, 'betsy-default', expect.anything())
    expect(completeFn).toHaveBeenCalledWith('abc-nonce-123', 'ws-1')
    expect(sendMessageFn).toHaveBeenCalledWith(
      12345,
      expect.stringMatching(/готово|привязал|готова/i),
    )
  })

  it('falls back to plain /start when payload is empty', async () => {
    const sendMessageFn = vi.fn()
    const plainStartFn = vi.fn()
    await handleStartCommand(
      { tgUserId: 12345, payload: '' },
      {
        tgLinkService: { getPresetId: vi.fn(), complete: vi.fn() } as any,
        workspaces: {} as any,
        personas: {} as any,
        sendMessage: sendMessageFn,
        plainStart: plainStartFn,
      },
    )
    expect(plainStartFn).toHaveBeenCalledWith(12345)
  })

  it('sends "ссылка устарела" if nonce is unknown or expired', async () => {
    const sendMessageFn = vi.fn()
    await handleStartCommand(
      { tgUserId: 12345, payload: 'expired-nonce' },
      {
        tgLinkService: { getPresetId: vi.fn(async () => null), complete: vi.fn() } as any,
        workspaces: {} as any,
        personas: {} as any,
        sendMessage: sendMessageFn,
      },
    )
    expect(sendMessageFn).toHaveBeenCalledWith(
      12345,
      expect.stringMatching(/устарел|истёк|expired/i),
    )
  })
})
```

- [ ] **Step 3: Implement / refactor `/start` handler**

Extract `/start` handling into `handleStartCommand(event, deps)` so it's testable. Wire into existing dispatcher.

```typescript
// src/multi/bot-router/router.ts (excerpt)
import { getPreset } from '../personas/presets.js'

export interface StartHandlerDeps {
  tgLinkService: TgLinkService
  workspaces: WorkspaceRepo
  personas: PersonaRepo
  sendMessage: (tgUserId: number, text: string) => Promise<void> | void
  /** Called when /start has no nonce — the existing onboarding flow */
  plainStart?: (tgUserId: number) => Promise<void> | void
}

export async function handleStartCommand(
  event: { tgUserId: number; payload: string },
  deps: StartHandlerDeps,
): Promise<void> {
  const { tgUserId, payload } = event
  const nonce = payload.trim()

  if (!nonce) {
    if (deps.plainStart) await deps.plainStart(tgUserId)
    return
  }

  const presetId = await deps.tgLinkService.getPresetId(nonce)
  if (!presetId) {
    await deps.sendMessage(
      tgUserId,
      'Ссылка устарела. Открой Бетси на компьютере и нажми «Войти через Telegram» снова.',
    )
    return
  }

  const ws = await deps.workspaces.createFromTelegramLogin(tgUserId, presetId, deps.personas)
  await deps.tgLinkService.complete(nonce, ws.id)

  const preset = getPreset(presetId)!
  await deps.sendMessage(
    tgUserId,
    `Готово! Я — ${preset.name}. Пиши мне сюда, я отвечу.`,
  )
}
```

In existing router dispatch where `/start` is currently handled, replace with:

```typescript
case 'start':
  await handleStartCommand(
    { tgUserId: update.from.id, payload: update.payload ?? '' },
    {
      tgLinkService,
      workspaces: workspaceRepo,
      personas: personaRepo,
      sendMessage: (id, txt) => bot.sendMessage(id, txt),
      plainStart: (id) => existingOnboardingStart(id),  // current handler
    },
  )
  break
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npx vitest run tests/multi/bot-router/tg-link-start.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/multi/bot-router/router.ts tests/multi/bot-router/tg-link-start.test.ts
git commit -m "feat(bot-router): handle /start <nonce> — link wizard to workspace"
```

---

## Task 11: End-to-end integration test

**Files:**
- Test: `tests/multi/e2e/tg-link-flow.test.ts`

Walks the full path: app calls `/auth/tg-link/start` → simulates bot receiving `/start <nonce>` → app polls and gets jwt.

- [ ] **Step 1: Write the test**

```typescript
// tests/multi/e2e/tg-link-flow.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createTestServer } from '../helpers/test-server.js'

const BC_TEST_DATABASE_URL = process.env.BC_TEST_DATABASE_URL

describe.skipIf(!BC_TEST_DATABASE_URL)('e2e tg-link flow', () => {
  let server: { url: string; close: () => Promise<void>; simulateBotStart: (tgUserId: number, payload: string) => Promise<void> }
  let pool: Pool

  beforeAll(async () => {
    server = await createTestServer()
    pool = new Pool({ connectionString: BC_TEST_DATABASE_URL })
  })
  afterAll(async () => {
    await server.close()
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query(`delete from workspaces where owner_tg_id = 999001`)
    await pool.query(`truncate bc_tg_link_nonces`)
  })

  it('full flow: start → bot /start → poll returns jwt', async () => {
    // 1. App starts the link
    const startRes = await fetch(`${server.url}/auth/tg-link/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId: 'betsy-default' }),
    })
    const { nonce, deepLink } = await startRes.json()
    expect(deepLink).toContain(nonce)

    // 2. App starts polling
    const pollPromise = fetch(`${server.url}/auth/tg-link/poll?nonce=${nonce}&maxWaitMs=5000`)

    // 3. Simulate user pressing Start in TG (small delay)
    await new Promise((r) => setTimeout(r, 300))
    await server.simulateBotStart(999001, nonce)

    // 4. Poll resolves with jwt
    const pollRes = await pollPromise
    expect(pollRes.status).toBe(200)
    const body = await pollRes.json()
    expect(body.jwt).toBeTypeOf('string')
    expect(body.workspaceId).toBeTypeOf('string')

    // 5. Workspace is created with persona
    const { rows } = await pool.query(
      `select persona_id from workspaces where id = $1`,
      [body.workspaceId],
    )
    expect(rows[0].persona_id).not.toBeNull()
  })

  it('replay protection: same nonce used twice returns 404 on second /start', async () => {
    const { nonce } = await fetch(`${server.url}/auth/tg-link/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId: 'betsy-default' }),
    }).then((r) => r.json())

    await server.simulateBotStart(999001, nonce)
    // second /start with same nonce — already used, getPresetId returns null
    await expect(server.simulateBotStart(999001, nonce)).resolves.not.toThrow()
    // We can't directly assert "ссылка устарела" without intercepting bot messages.
    // Instead verify nonce row state.
    const { rows } = await pool.query(
      `select used, completed_at from bc_tg_link_nonces where nonce = $1`,
      [nonce],
    )
    expect(rows[0].used).toBe(true)
  })
})
```

`createTestServer().simulateBotStart` — extend the helper to dispatch a fake update through `handleStartCommand`. Implementation in helper:

```typescript
// tests/multi/helpers/test-server.ts (excerpt)
return {
  url,
  close,
  simulateBotStart: async (tgUserId: number, payload: string) => {
    await handleStartCommand(
      { tgUserId, payload },
      {
        tgLinkService: app.tgLinkService,
        workspaces: app.workspaceRepo,
        personas: app.personaRepo,
        sendMessage: () => Promise.resolve(),  // no-op in test
      },
    )
  },
}
```

- [ ] **Step 2: Run, expect pass**

```bash
BC_TEST_DATABASE_URL=$BC_TEST_DATABASE_URL npx vitest run tests/multi/e2e/tg-link-flow.test.ts
```

Expected: PASS (2 tests)

- [ ] **Step 3: Run all P1.A tests**

```bash
BC_TEST_DATABASE_URL=$BC_TEST_DATABASE_URL npx vitest run tests/multi/personas/presets.test.ts tests/multi/auth/ tests/multi/server/catalog-personas.test.ts tests/multi/server/auth-tg-link.test.ts tests/multi/workspaces/repo.test.ts tests/multi/bot-router/tg-link-start.test.ts tests/multi/e2e/tg-link-flow.test.ts
```

Expected: ALL PASS

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add tests/multi/e2e/tg-link-flow.test.ts tests/multi/helpers/test-server.ts
git commit -m "test(e2e): full tg-link flow happy path + replay protection"
```

---

## Task 12: Periodic nonce sweep

**Files:**
- Modify: `src/multi/cron-wiring.ts` (existing pg-boss cron registry)
- Test: minimal smoke test

- [ ] **Step 1: Locate existing cron registration**

```bash
# Grep: "pg-boss" or "schedule" in src/multi/cron-wiring.ts
```

- [ ] **Step 2: Add sweep job**

```typescript
// src/multi/cron-wiring.ts (excerpt)
import { TgLinkRepo } from './auth/tg-link-repo.js'

// inside the wiring function, alongside other queues:
const tgLinkRepo = deps.tgLinkRepo  // pass in via deps
await boss.createQueue('tg-link-sweep')
await boss.work('tg-link-sweep', async () => {
  const deleted = await tgLinkRepo.sweepExpired()
  log.info({ deleted }, 'tg-link-sweep')
})
await boss.schedule('tg-link-sweep', '*/15 * * * *')  // every 15 min
```

- [ ] **Step 3: Smoke test** — manually run the multi server with `BC_MODE=multi npm run dev`, wait 16 minutes (or trigger the queue via existing admin endpoint), inspect logs for `tg-link-sweep` entry. Document this in the PR as manual verification.

- [ ] **Step 4: Commit**

```bash
git add src/multi/cron-wiring.ts
git commit -m "feat(cron): schedule tg-link-sweep every 15min to purge expired nonces"
```

---

## Final checks

- [ ] **Run full vitest suite** — `npm test` — expect green, no regressions in other modules
- [ ] **Typecheck** — `npm run typecheck` — clean
- [ ] **Build** — `npm run build` — succeeds
- [ ] **Update CLAUDE.md if needed** — only if naming conventions changed or new repo subdirectory was added (e.g., `src/multi/auth/`)

---

## Notes for executor

- All integration tests are gated on `BC_TEST_DATABASE_URL` and skip otherwise — local dev needs a test DB.
- `tests/multi/helpers/test-server.ts` is referenced repeatedly — if it doesn't exist, find how existing integration tests bootstrap a server (`src/multi/sim/` may have examples). Either way, create the helper as the first sub-step of Task 3.
- JWT format: HS256 via `node:crypto`, per CLAUDE.md. If the helper isn't already in a shared place, extract before Task 6.
- Avatars in presets reference `cdn.betsyai.io` — that CDN is part of P1.C (infra plan). For P1.A tests we only check the URL is a valid string; the actual hosting is P1.C's problem.
- Two presets are placeholders for content — real names, bios, and avatar URLs will be tuned during P2 (Persona Marketplace). The schema and machinery they exercise are what we lock in here.
