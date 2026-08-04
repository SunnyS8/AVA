# P1.B — Electron Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `betsy-app/` Electron package — Windows installer, first-run wizard (persona → mode → hosted/self-host branches → done), minimal main chat window, control panel, and the local infra (SSH bootstrap, secure storage, persona cache, updater).

**Architecture:** Electron app in monorepo at `betsy-app/`. Main process (Node) hosts: wizard state machine, persona cache (SQLite + blob), SSH bootstrap via `ssh2`, hosted TG-link via `fetch` against P1.A endpoints, secure storage via `safeStorage`, electron-updater. Renderer (React) reuses `src/ui/` build tooling, exposes wizard screens, chat window, control panel. Renderer communicates with main via IPC. Main process owns the WSS connection to remote engine (re-using `src/channels/browser` protocol).

**Tech Stack:** Electron 30+, electron-builder, electron-updater, ssh2, better-sqlite3, React 18 + Tailwind (reuse src/ui/), vitest, Playwright + electron-driver. Spec: [docs/superpowers/specs/2026-05-24-distribution-shell-p1-design.md](../specs/2026-05-24-distribution-shell-p1-design.md). Depends on P1.A endpoints for happy-path integration tests.

---

## File Structure

### New top-level package: `betsy-app/`

```
betsy-app/
├── package.json              # Own package; lists Electron deps
├── tsconfig.json
├── electron-builder.json     # NSIS config, code-sign, updater feed
├── src/
│   ├── main/
│   │   ├── index.ts                # Electron entry; window lifecycle
│   │   ├── ipc.ts                  # IPC handler registry
│   │   ├── wizard-engine.ts        # State machine; pure logic
│   │   ├── persona-cache.ts        # Fetch /catalog/personas → SQLite + blob
│   │   ├── hosted-auth.ts          # Calls P1.A /auth/tg-link/start + poll
│   │   ├── ssh-bootstrap.ts        # ssh2 + docker-compose template + stream stdout
│   │   ├── docker-compose-template.ts  # Constants + .env generator
│   │   ├── backend-connector.ts    # WSS to remote engine; auto-reconnect
│   │   ├── secure-storage.ts       # safeStorage wrapper
│   │   ├── updater.ts              # electron-updater wrapper
│   │   ├── engine-update.ts        # Self-host engine update via SSH
│   │   ├── settings-store.ts       # Persistent local config (mode, host URL, etc.)
│   │   └── logger.ts               # File logger (rotated, 5MB max)
│   ├── renderer/
│   │   ├── index.html
│   │   ├── main.tsx                # Renderer entry
│   │   ├── App.tsx                 # Router: wizard | main | settings
│   │   ├── ipc.ts                  # Typed IPC wrapper (window.api)
│   │   ├── wizard/
│   │   │   ├── WizardShell.tsx     # Header (persona avatar + line), step container
│   │   │   ├── PersonaPicker.tsx
│   │   │   ├── ModeSelect.tsx
│   │   │   ├── hosted/
│   │   │   │   ├── HostedLogin.tsx
│   │   │   │   └── HostedWaiting.tsx
│   │   │   └── selfhost/
│   │   │       ├── SshForm.tsx
│   │   │       ├── InstallProgress.tsx
│   │   │       └── BotTokenForm.tsx
│   │   ├── chat/
│   │   │   ├── ChatWindow.tsx
│   │   │   ├── AvatarPanel.tsx
│   │   │   └── MessageList.tsx
│   │   └── control-panel/
│   │       ├── ControlPanel.tsx
│   │       ├── StatusTab.tsx
│   │       ├── PersonaTab.tsx
│   │       ├── EngineUpdateTab.tsx
│   │       └── DangerZoneTab.tsx
│   └── preload/
│       └── preload.ts              # ContextBridge: expose typed window.api
├── resources/
│   ├── docker-compose.template.yml # Shipped with installer
│   ├── icons/
│   │   ├── betsy.ico
│   │   └── betsy.png
│   └── installer/
│       └── nsis-include.nsh        # NSIS customizations
└── tests/
    ├── unit/
    │   ├── wizard-engine.test.ts
    │   ├── persona-cache.test.ts
    │   ├── ssh-bootstrap.test.ts
    │   └── docker-compose-template.test.ts
    └── e2e/
        ├── helpers/
        │   ├── electron-driver.ts  # Playwright + electron launcher
        │   └── mock-backend.ts     # Mocks P1.A endpoints
        ├── wizard-hosted.test.ts
        └── wizard-selfhost.test.ts # Uses sshd-test-container
```

### Modified files in main repo
- Root `package.json` — register `betsy-app` workspace (if monorepo uses npm workspaces) or add post-install hook
- `.gitignore` — `betsy-app/dist/`, `betsy-app/release/`, `betsy-app/node_modules/`
- `CLAUDE.md` — short paragraph about `betsy-app/` layer if conventions need it

---

## Task 1: Bootstrap `betsy-app/` package

**Files:**
- Create: `betsy-app/package.json`
- Create: `betsy-app/tsconfig.json`
- Create: `betsy-app/electron-builder.json`
- Create: `betsy-app/.gitignore`
- Modify: root `package.json` (workspace) + `.gitignore`

- [ ] **Step 1: Decide workspace strategy**

Check root `package.json` for `workspaces:`. If absent, run:

```bash
node -e "const p=require('./package.json');p.workspaces=['betsy-app'];require('fs').writeFileSync('package.json',JSON.stringify(p,null,2))"
```

Otherwise add `"betsy-app"` to the existing array.

- [ ] **Step 2: Create betsy-app/package.json**

```json
{
  "name": "betsy-app",
  "version": "0.0.0",
  "private": true,
  "main": "dist/main/index.js",
  "scripts": {
    "dev": "vite dev",
    "build:main": "tsc -p tsconfig.main.json",
    "build:renderer": "vite build",
    "build:preload": "tsc -p tsconfig.preload.json",
    "build": "npm run build:main && npm run build:preload && npm run build:renderer",
    "start": "electron .",
    "dist": "npm run build && electron-builder --win --x64",
    "test": "vitest run",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "ssh2": "^1.15.0",
    "better-sqlite3": "^11.0.0",
    "electron-updater": "^6.2.1"
  },
  "devDependencies": {
    "electron": "^31.0.0",
    "electron-builder": "^25.0.0",
    "@types/ssh2": "^1.15.0",
    "@types/better-sqlite3": "^7.6.10",
    "vite": "^5.3.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@types/react": "^18.3.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@playwright/test": "^1.45.0"
  }
}
```

- [ ] **Step 3: Three tsconfig files**

```json
// betsy-app/tsconfig.json (base, used by editor)
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}

// betsy-app/tsconfig.main.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "node",
    "outDir": "dist/main"
  },
  "include": ["src/main/**/*"]
}

// betsy-app/tsconfig.preload.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "node",
    "outDir": "dist/preload"
  },
  "include": ["src/preload/**/*"]
}
```

- [ ] **Step 4: betsy-app/electron-builder.json**

```json
{
  "appId": "io.betsyai.app",
  "productName": "Betsy",
  "directories": { "output": "release" },
  "files": [
    "dist/**/*",
    "resources/**/*",
    "package.json",
    "!node_modules/**/{test,docs,examples}/**/*"
  ],
  "extraResources": [
    { "from": "resources/docker-compose.template.yml", "to": "docker-compose.template.yml" }
  ],
  "win": {
    "target": ["nsis"],
    "icon": "resources/icons/betsy.ico",
    "publisherName": "Betsy AI",
    "signingHashAlgorithms": ["sha256"]
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "perMachine": false,
    "deleteAppDataOnUninstall": false
  },
  "publish": [
    {
      "provider": "generic",
      "url": "https://updates.betsyai.io/electron/win-x64",
      "channel": "latest"
    }
  ]
}
```

- [ ] **Step 5: betsy-app/.gitignore + root .gitignore update**

```gitignore
# betsy-app/.gitignore
dist/
release/
node_modules/
*.log
```

Add to root `.gitignore`:
```
betsy-app/dist/
betsy-app/release/
```

- [ ] **Step 6: Install deps and verify**

```bash
cd betsy-app && npm install
npm ls electron  # should list electron
```

- [ ] **Step 7: Commit**

```bash
git add betsy-app/package.json betsy-app/tsconfig*.json betsy-app/electron-builder.json betsy-app/.gitignore .gitignore package.json package-lock.json
git commit -m "feat(betsy-app): bootstrap Electron package scaffold"
```

---

## Task 2: Minimal Electron entry — empty window opens

**Files:**
- Create: `betsy-app/src/main/index.ts`
- Create: `betsy-app/src/main/logger.ts`
- Create: `betsy-app/src/renderer/index.html`
- Create: `betsy-app/src/renderer/main.tsx`
- Create: `betsy-app/src/renderer/App.tsx`
- Create: `betsy-app/src/preload/preload.ts`
- Create: `betsy-app/vite.config.ts`

- [ ] **Step 1: Logger**

```typescript
// betsy-app/src/main/logger.ts
import { app } from 'electron'
import { mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = join(app.getPath('userData'), 'logs')
const LOG_FILE = join(LOG_DIR, 'betsy-app.log')
const MAX_SIZE = 5 * 1024 * 1024

mkdirSync(LOG_DIR, { recursive: true })

function rotate() {
  try {
    const s = statSync(LOG_FILE)
    if (s.size > MAX_SIZE) renameSync(LOG_FILE, LOG_FILE + '.1')
  } catch {}
}

export function log(level: 'info' | 'warn' | 'error', msg: string, meta?: object) {
  rotate()
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta }) + '\n'
  appendFileSync(LOG_FILE, line)
  if (process.env.NODE_ENV !== 'production') console[level](msg, meta ?? '')
}
```

- [ ] **Step 2: Electron entry**

```typescript
// betsy-app/src/main/index.ts
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { log } from './logger.js'

const isDev = !!process.env.VITE_DEV_SERVER_URL

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    title: 'Betsy',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL!)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }
}

app.whenReady().then(() => {
  log('info', 'app-ready')
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 3: Preload (empty contextBridge for now)**

```typescript
// betsy-app/src/preload/preload.ts
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('api', {
  ping: () => 'pong',
})
```

- [ ] **Step 4: Renderer skeleton**

```html
<!-- betsy-app/src/renderer/index.html -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Betsy</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
```

```tsx
// betsy-app/src/renderer/main.tsx
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
createRoot(document.getElementById('root')!).render(<App />)
```

```tsx
// betsy-app/src/renderer/App.tsx
export function App() {
  return <div style={{ padding: 32, fontFamily: 'sans-serif' }}>Betsy — loading</div>
}
```

- [ ] **Step 5: vite.config.ts**

```typescript
// betsy-app/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: 'src/renderer',
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  plugins: [react()],
})
```

Add `@vitejs/plugin-react` to devDeps (Task 1's `npm install` will need re-run).

- [ ] **Step 6: Build and launch**

```bash
cd betsy-app && npm run build && npm start
```

Expected: window opens with "Betsy — loading" text. Close.

- [ ] **Step 7: Commit**

```bash
git add betsy-app/
git commit -m "feat(betsy-app): minimal Electron window opens"
```

---

## Task 3: PersonaCache — fetches /catalog/personas, stores in SQLite

**Files:**
- Create: `betsy-app/src/main/persona-cache.ts`
- Test: `betsy-app/tests/unit/persona-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// betsy-app/tests/unit/persona-cache.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonaCache } from '../../src/main/persona-cache.js'

describe('PersonaCache', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pcache-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('fetches from catalog URL and stores presets', async () => {
    const presetsFromServer = [
      { id: 'p1', name: 'P1', gender: 'female', voiceId: 'A', defaultBehavior: { voice: 'auto', selfie: 'auto', video: 'auto' }, biography: 'b', defaultPersonalityPrompt: 'pp', avatar: { static: 'https://x/a.png' }, wizardLines: { mode_intro: 'a', mode_selfhost_checklist: ['x'], mode_selfhost_hint: 'h', tg_login_intro: 'a', tg_login_waiting: 'a', tg_login_success: 'a', ssh_prompt: 'a', ssh_test_ok: 'a', install_progress: 'a', install_done: 'a', bot_token_prompt: 'a', bot_webhook_ok: 'a', wizard_complete: 'a' } },
    ]
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/catalog/personas')) {
        return { ok: true, status: 200, json: async () => presetsFromServer, headers: { get: () => 'application/json' } } as any
      }
      // avatar download
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as any
    })
    const cache = new PersonaCache(dir, 'https://api.test', fetchMock)
    await cache.refresh()
    const list = await cache.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('p1')
  })

  it('list() works offline after refresh (no fetch call)', async () => {
    // Seed via direct DB write (or via refresh + then reset fetch)
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [], arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => 'application/json' } } as any))
    const cache = new PersonaCache(dir, 'https://api.test', fetchMock)
    await cache.refresh()
    fetchMock.mockClear()
    const list = await cache.list()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(list).toEqual([])
  })

  it('getAvatarPath returns local file path after refresh', async () => {
    const presets = [
      { id: 'p1', name: 'P1', gender: null, voiceId: 'A', defaultBehavior: { voice: 'auto', selfie: 'auto', video: 'auto' }, biography: 'b', defaultPersonalityPrompt: 'pp', avatar: { static: 'https://x/a.png' }, wizardLines: { mode_intro: 'a', mode_selfhost_checklist: ['x'], mode_selfhost_hint: 'h', tg_login_intro: 'a', tg_login_waiting: 'a', tg_login_success: 'a', ssh_prompt: 'a', ssh_test_ok: 'a', install_progress: 'a', install_done: 'a', bot_token_prompt: 'a', bot_webhook_ok: 'a', wizard_complete: 'a' } },
    ]
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('catalog')
        ? { ok: true, status: 200, json: async () => presets, headers: { get: () => 'application/json' } } as any
        : { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([255, 1, 2, 3]).buffer } as any
    )
    const cache = new PersonaCache(dir, 'https://api.test', fetchMock)
    await cache.refresh()
    const p = await cache.getAvatarPath('p1')
    expect(p).toBeTruthy()
    expect(p!.endsWith('.bin') || p!.endsWith('.png')).toBe(true)
  })
})
```

- [ ] **Step 2: Implement PersonaCache**

```typescript
// betsy-app/src/main/persona-cache.ts
import Database from 'better-sqlite3'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface CachedPreset {
  id: string
  name: string
  gender: string | null
  voiceId: string
  defaultBehavior: any
  biography: string
  defaultPersonalityPrompt: string
  avatar: { static: string; voiceSample?: string }
  wizardLines: Record<string, string | string[]>
}

type FetchFn = (url: string, init?: any) => Promise<any>

export class PersonaCache {
  private db: Database.Database
  private blobDir: string

  constructor(
    private dir: string,
    private apiBase: string,
    private fetchFn: FetchFn = fetch,
  ) {
    mkdirSync(dir, { recursive: true })
    this.db = new Database(join(dir, 'persona-cache.db'))
    this.db.exec(`
      create table if not exists presets (
        id text primary key,
        json text not null,
        avatar_blob_path text,
        updated_at integer not null
      );
    `)
    this.blobDir = join(dir, 'blobs')
    mkdirSync(this.blobDir, { recursive: true })
  }

  async refresh(): Promise<void> {
    const res = await this.fetchFn(`${this.apiBase}/catalog/personas`)
    if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`)
    const presets: CachedPreset[] = await res.json()

    const upsert = this.db.prepare(`
      insert into presets (id, json, avatar_blob_path, updated_at)
      values (?, ?, ?, ?)
      on conflict(id) do update set json = excluded.json, avatar_blob_path = excluded.avatar_blob_path, updated_at = excluded.updated_at
    `)

    for (const p of presets) {
      let blobPath: string | null = null
      try {
        const r = await this.fetchFn(p.avatar.static)
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer())
          blobPath = join(this.blobDir, `${p.id}-avatar.bin`)
          writeFileSync(blobPath, buf)
        }
      } catch {}
      upsert.run(p.id, JSON.stringify(p), blobPath, Date.now())
    }

    // remove presets no longer in catalog
    const ids = presets.map((p) => p.id)
    if (ids.length > 0) {
      this.db.prepare(
        `delete from presets where id not in (${ids.map(() => '?').join(',')})`,
      ).run(...ids)
    }
  }

  async list(): Promise<CachedPreset[]> {
    const rows = this.db.prepare('select json from presets order by id').all() as { json: string }[]
    return rows.map((r) => JSON.parse(r.json))
  }

  async get(id: string): Promise<CachedPreset | null> {
    const row = this.db.prepare('select json from presets where id = ?').get(id) as
      | { json: string }
      | undefined
    return row ? JSON.parse(row.json) : null
  }

  async getAvatarPath(id: string): Promise<string | null> {
    const row = this.db.prepare('select avatar_blob_path from presets where id = ?').get(id) as
      | { avatar_blob_path: string | null }
      | undefined
    if (row?.avatar_blob_path && existsSync(row.avatar_blob_path)) return row.avatar_blob_path
    return null
  }

  hasAny(): boolean {
    const row = this.db.prepare('select count(*) as c from presets').get() as { c: number }
    return row.c > 0
  }
}
```

- [ ] **Step 3: Run tests**

```bash
cd betsy-app && npx vitest run tests/unit/persona-cache.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 4: Commit**

```bash
git add betsy-app/src/main/persona-cache.ts betsy-app/tests/unit/persona-cache.test.ts
git commit -m "feat(betsy-app): PersonaCache — SQLite + blob storage for offline wizard"
```

---

## Task 4: WizardEngine — pure state machine

**Files:**
- Create: `betsy-app/src/main/wizard-engine.ts`
- Test: `betsy-app/tests/unit/wizard-engine.test.ts`

The wizard engine is a pure state machine. Inputs: user actions + async results. Output: current state + next allowed transitions. No I/O — that's done by main process around it.

- [ ] **Step 1: Define states and events**

```typescript
// betsy-app/src/main/wizard-engine.ts
export type WizardStep =
  | 'persona-picker'
  | 'mode-select'
  | 'hosted-login'        // shows "click to open Telegram"
  | 'hosted-waiting'      // polling /auth/tg-link/poll
  | 'selfhost-ssh-form'
  | 'selfhost-install'
  | 'selfhost-bot-token'
  | 'done'

export interface WizardState {
  step: WizardStep
  selectedPresetId: string | null
  mode: 'hosted' | 'selfhost' | null
  hostedNonce: string | null
  hostedDeepLink: string | null
  hostedJwt: string | null
  hostedWorkspaceId: string | null
  sshHost: string | null
  sshPort: number | null
  sshUser: string | null
  sshAuthKind: 'password' | 'key' | null
  // never store password / key contents in state — they're held in main process memory only
  installProgress: number  // 0..100
  installLog: string[]
  installError: string | null
  botToken: string | null
  botWebhookOk: boolean
}

export type WizardEvent =
  | { type: 'persona-selected'; presetId: string }
  | { type: 'mode-selected'; mode: 'hosted' | 'selfhost' }
  | { type: 'hosted-nonce-received'; nonce: string; deepLink: string }
  | { type: 'hosted-poll-success'; jwt: string; workspaceId: string }
  | { type: 'hosted-poll-timeout' }
  | { type: 'ssh-creds-submitted'; host: string; port: number; user: string; authKind: 'password' | 'key' }
  | { type: 'ssh-test-passed' }
  | { type: 'install-progress'; pct: number; logLine?: string }
  | { type: 'install-done' }
  | { type: 'install-failed'; error: string }
  | { type: 'bot-token-submitted'; token: string }
  | { type: 'bot-webhook-ok' }
  | { type: 'back' }
  | { type: 'reset' }

export function initialState(): WizardState {
  return {
    step: 'persona-picker',
    selectedPresetId: null,
    mode: null,
    hostedNonce: null,
    hostedDeepLink: null,
    hostedJwt: null,
    hostedWorkspaceId: null,
    sshHost: null,
    sshPort: null,
    sshUser: null,
    sshAuthKind: null,
    installProgress: 0,
    installLog: [],
    installError: null,
    botToken: null,
    botWebhookOk: false,
  }
}

export function reduce(state: WizardState, event: WizardEvent): WizardState {
  switch (event.type) {
    case 'persona-selected':
      return { ...state, selectedPresetId: event.presetId, step: 'mode-select' }
    case 'mode-selected':
      if (!state.selectedPresetId) return state
      return {
        ...state,
        mode: event.mode,
        step: event.mode === 'hosted' ? 'hosted-login' : 'selfhost-ssh-form',
      }
    case 'hosted-nonce-received':
      return { ...state, hostedNonce: event.nonce, hostedDeepLink: event.deepLink, step: 'hosted-waiting' }
    case 'hosted-poll-success':
      return { ...state, hostedJwt: event.jwt, hostedWorkspaceId: event.workspaceId, step: 'done' }
    case 'hosted-poll-timeout':
      return { ...state, step: 'hosted-login' }
    case 'ssh-creds-submitted':
      return { ...state, sshHost: event.host, sshPort: event.port, sshUser: event.user, sshAuthKind: event.authKind, step: 'selfhost-install' }
    case 'install-progress':
      return {
        ...state,
        installProgress: event.pct,
        installLog: event.logLine ? [...state.installLog, event.logLine] : state.installLog,
      }
    case 'install-done':
      return { ...state, installProgress: 100, step: 'selfhost-bot-token' }
    case 'install-failed':
      return { ...state, installError: event.error }
    case 'bot-token-submitted':
      return { ...state, botToken: event.token }
    case 'bot-webhook-ok':
      return { ...state, botWebhookOk: true, step: 'done' }
    case 'back':
      return reduceBack(state)
    case 'reset':
      return initialState()
    default:
      return state
  }
}

function reduceBack(state: WizardState): WizardState {
  const order: WizardStep[] = [
    'persona-picker',
    'mode-select',
    state.mode === 'hosted' ? 'hosted-login' : 'selfhost-ssh-form',
    state.mode === 'hosted' ? 'hosted-waiting' : 'selfhost-install',
  ]
  const idx = order.indexOf(state.step)
  if (idx <= 0) return state
  return { ...state, step: order[idx - 1] }
}
```

- [ ] **Step 2: Write tests**

```typescript
// betsy-app/tests/unit/wizard-engine.test.ts
import { describe, expect, it } from 'vitest'
import { initialState, reduce } from '../../src/main/wizard-engine.js'

describe('WizardEngine', () => {
  it('starts at persona-picker', () => {
    expect(initialState().step).toBe('persona-picker')
  })

  it('persona-selected advances to mode-select', () => {
    const s = reduce(initialState(), { type: 'persona-selected', presetId: 'betsy-default' })
    expect(s.step).toBe('mode-select')
    expect(s.selectedPresetId).toBe('betsy-default')
  })

  it('hosted path: mode-select → hosted-login → hosted-waiting → done', () => {
    let s = reduce(initialState(), { type: 'persona-selected', presetId: 'betsy-default' })
    s = reduce(s, { type: 'mode-selected', mode: 'hosted' })
    expect(s.step).toBe('hosted-login')
    s = reduce(s, { type: 'hosted-nonce-received', nonce: 'n1', deepLink: 'https://t.me/x?start=n1' })
    expect(s.step).toBe('hosted-waiting')
    s = reduce(s, { type: 'hosted-poll-success', jwt: 'jwt-1', workspaceId: 'ws-1' })
    expect(s.step).toBe('done')
    expect(s.hostedJwt).toBe('jwt-1')
  })

  it('hosted poll timeout returns to hosted-login', () => {
    let s = reduce(initialState(), { type: 'persona-selected', presetId: 'betsy-default' })
    s = reduce(s, { type: 'mode-selected', mode: 'hosted' })
    s = reduce(s, { type: 'hosted-nonce-received', nonce: 'n1', deepLink: 'x' })
    s = reduce(s, { type: 'hosted-poll-timeout' })
    expect(s.step).toBe('hosted-login')
  })

  it('selfhost path: ssh → install → bot-token → done', () => {
    let s = reduce(initialState(), { type: 'persona-selected', presetId: 'betsy-default' })
    s = reduce(s, { type: 'mode-selected', mode: 'selfhost' })
    expect(s.step).toBe('selfhost-ssh-form')
    s = reduce(s, { type: 'ssh-creds-submitted', host: 'h', port: 22, user: 'u', authKind: 'key' })
    expect(s.step).toBe('selfhost-install')
    s = reduce(s, { type: 'install-progress', pct: 50, logLine: 'pull layer 5/12' })
    expect(s.installProgress).toBe(50)
    expect(s.installLog).toContain('pull layer 5/12')
    s = reduce(s, { type: 'install-done' })
    expect(s.step).toBe('selfhost-bot-token')
    s = reduce(s, { type: 'bot-token-submitted', token: '123:abc' })
    expect(s.botToken).toBe('123:abc')
    s = reduce(s, { type: 'bot-webhook-ok' })
    expect(s.step).toBe('done')
  })

  it('reset returns to initial', () => {
    let s = reduce(initialState(), { type: 'persona-selected', presetId: 'betsy-default' })
    s = reduce(s, { type: 'reset' })
    expect(s).toEqual(initialState())
  })

  it('mode-selected without persona is a no-op', () => {
    const s = reduce(initialState(), { type: 'mode-selected', mode: 'hosted' })
    expect(s.step).toBe('persona-picker')
  })
})
```

- [ ] **Step 3: Run tests, expect pass**

```bash
cd betsy-app && npx vitest run tests/unit/wizard-engine.test.ts
```

Expected: PASS (7 tests)

- [ ] **Step 4: Commit**

```bash
git add betsy-app/src/main/wizard-engine.ts betsy-app/tests/unit/wizard-engine.test.ts
git commit -m "feat(betsy-app): WizardEngine pure state machine + tests"
```

---

## Task 5: HostedAuth driver — calls P1.A endpoints

**Files:**
- Create: `betsy-app/src/main/hosted-auth.ts`
- Test: `betsy-app/tests/unit/hosted-auth.test.ts`

- [ ] **Step 1: Write test**

```typescript
// betsy-app/tests/unit/hosted-auth.test.ts
import { describe, expect, it, vi } from 'vitest'
import { HostedAuth } from '../../src/main/hosted-auth.js'

describe('HostedAuth', () => {
  it('start() POSTs to /auth/tg-link/start and returns nonce + deepLink', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ nonce: 'n1', deepLink: 'https://t.me/x?start=n1', expiresIn: 300 }) } as any))
    const a = new HostedAuth('https://api.test', fetchMock)
    const r = await a.start('betsy-default')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/auth/tg-link/start',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetId: 'betsy-default' }),
      }),
    )
    expect(r.nonce).toBe('n1')
  })

  it('poll() returns {jwt, workspaceId} on 200', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ jwt: 'jwt-1', workspaceId: 'ws-1' }) } as any))
    const a = new HostedAuth('https://api.test', fetchMock)
    const r = await a.poll('n1')
    expect(r).toEqual({ kind: 'completed', jwt: 'jwt-1', workspaceId: 'ws-1' })
  })

  it('poll() returns timeout on 408', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 408, json: async () => ({}) } as any))
    const a = new HostedAuth('https://api.test', fetchMock)
    const r = await a.poll('n1')
    expect(r).toEqual({ kind: 'timeout' })
  })

  it('poll() returns expired on 404', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as any))
    const a = new HostedAuth('https://api.test', fetchMock)
    const r = await a.poll('n1')
    expect(r).toEqual({ kind: 'expired' })
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// betsy-app/src/main/hosted-auth.ts
type FetchFn = typeof fetch

export type PollResult =
  | { kind: 'completed'; jwt: string; workspaceId: string }
  | { kind: 'timeout' }
  | { kind: 'expired' }
  | { kind: 'error'; status: number; message: string }

export class HostedAuth {
  constructor(private apiBase: string, private fetchFn: FetchFn = fetch) {}

  async start(presetId: string): Promise<{ nonce: string; deepLink: string; expiresIn: number }> {
    const res = await this.fetchFn(`${this.apiBase}/auth/tg-link/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId }),
    })
    if (!res.ok) throw new Error(`start failed: ${res.status}`)
    return res.json()
  }

  /** One long-poll round. Caller can loop. */
  async poll(nonce: string, maxWaitMs = 30_000): Promise<PollResult> {
    const res = await this.fetchFn(
      `${this.apiBase}/auth/tg-link/poll?nonce=${encodeURIComponent(nonce)}&maxWaitMs=${maxWaitMs}`,
    )
    if (res.status === 200) {
      const b = await res.json()
      return { kind: 'completed', jwt: b.jwt, workspaceId: b.workspaceId }
    }
    if (res.status === 404) return { kind: 'expired' }
    if (res.status === 408) return { kind: 'timeout' }
    return { kind: 'error', status: res.status, message: 'unexpected' }
  }
}
```

- [ ] **Step 3: Run tests, expect pass**

```bash
cd betsy-app && npx vitest run tests/unit/hosted-auth.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add betsy-app/src/main/hosted-auth.ts betsy-app/tests/unit/hosted-auth.test.ts
git commit -m "feat(betsy-app): HostedAuth wrapper for /auth/tg-link/{start,poll}"
```

---

## Task 6: Docker-compose template generator

**Files:**
- Create: `betsy-app/resources/docker-compose.template.yml`
- Create: `betsy-app/src/main/docker-compose-template.ts`
- Test: `betsy-app/tests/unit/docker-compose-template.test.ts`

- [ ] **Step 1: Write the template**

```yaml
# betsy-app/resources/docker-compose.template.yml
version: '3.9'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: betsy
      POSTGRES_PASSWORD: ${BC_DB_PASSWORD}
      POSTGRES_DB: betsy
    volumes:
      - betsy-pg:/var/lib/postgresql/data
    restart: unless-stopped

  betsy:
    image: ghcr.io/betsyai/betsy-multi:${BC_ENGINE_VERSION:-latest}
    environment:
      BETSY_MODE: multi
      BC_DATABASE_URL: postgres://betsy:${BC_DB_PASSWORD}@postgres:5432/betsy
      BC_JWT_SECRET: ${BC_JWT_SECRET}
      BC_TG_BOT_TOKEN: ${BC_TG_BOT_TOKEN}
      BC_PUBLIC_URL: ${BC_PUBLIC_URL}
      BC_PERSONA_PRESET_ID: ${BC_PERSONA_PRESET_ID}
    ports:
      - '${BC_PORT:-3777}:3777'
    depends_on:
      - postgres
    restart: unless-stopped

volumes:
  betsy-pg:
```

- [ ] **Step 2: Write `.env` generator + tests**

```typescript
// betsy-app/src/main/docker-compose-template.ts
import { randomBytes } from 'node:crypto'

export interface EnvParams {
  presetId: string
  publicUrl: string
  port?: number
  botToken?: string
  engineVersion?: string
}

export interface GeneratedEnv {
  env: Record<string, string>
  asEnvFile: string
  dbPassword: string
  jwtSecret: string
}

export function generateEnv(params: EnvParams): GeneratedEnv {
  const dbPassword = randomBytes(24).toString('hex')
  const jwtSecret = randomBytes(48).toString('hex')
  const env: Record<string, string> = {
    BC_DB_PASSWORD: dbPassword,
    BC_JWT_SECRET: jwtSecret,
    BC_TG_BOT_TOKEN: params.botToken ?? '',
    BC_PUBLIC_URL: params.publicUrl,
    BC_PERSONA_PRESET_ID: params.presetId,
    BC_PORT: String(params.port ?? 3777),
    BC_ENGINE_VERSION: params.engineVersion ?? 'latest',
  }
  const asEnvFile = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n'
  return { env, asEnvFile, dbPassword, jwtSecret }
}
```

```typescript
// betsy-app/tests/unit/docker-compose-template.test.ts
import { describe, expect, it } from 'vitest'
import { generateEnv } from '../../src/main/docker-compose-template.js'

describe('generateEnv', () => {
  it('generates random db password and jwt secret', () => {
    const a = generateEnv({ presetId: 'betsy-default', publicUrl: 'http://1.2.3.4:3777' })
    const b = generateEnv({ presetId: 'betsy-default', publicUrl: 'http://1.2.3.4:3777' })
    expect(a.dbPassword).not.toBe(b.dbPassword)
    expect(a.jwtSecret).not.toBe(b.jwtSecret)
    expect(a.dbPassword.length).toBeGreaterThanOrEqual(40)
    expect(a.jwtSecret.length).toBeGreaterThanOrEqual(80)
  })

  it('includes all required env keys', () => {
    const { env } = generateEnv({ presetId: 'betsy-pro', publicUrl: 'http://x:3777' })
    expect(env.BC_PERSONA_PRESET_ID).toBe('betsy-pro')
    expect(env.BC_PUBLIC_URL).toBe('http://x:3777')
    expect(env.BC_PORT).toBe('3777')
    expect(env.BC_ENGINE_VERSION).toBe('latest')
    expect(env.BC_TG_BOT_TOKEN).toBe('')  // empty until bot step
  })

  it('asEnvFile is valid .env format', () => {
    const { asEnvFile } = generateEnv({ presetId: 'betsy-default', publicUrl: 'http://x' })
    expect(asEnvFile).toMatch(/^BC_DB_PASSWORD=.+$/m)
    expect(asEnvFile.endsWith('\n')).toBe(true)
    expect(asEnvFile).not.toMatch(/^=$/m)
  })
})
```

- [ ] **Step 3: Run, expect pass**

```bash
cd betsy-app && npx vitest run tests/unit/docker-compose-template.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 4: Commit**

```bash
git add betsy-app/resources/docker-compose.template.yml betsy-app/src/main/docker-compose-template.ts betsy-app/tests/unit/docker-compose-template.test.ts
git commit -m "feat(betsy-app): docker-compose template + .env generator"
```

---

## Task 7: SSH bootstrap — connect + checks + deploy

**Files:**
- Create: `betsy-app/src/main/ssh-bootstrap.ts`
- Test: `betsy-app/tests/unit/ssh-bootstrap.test.ts` (mocked ssh2)
- Test: `betsy-app/tests/e2e/wizard-selfhost.test.ts` references sshd-container (in Task 16)

Wraps `ssh2` Client. Exposes: `connect`, `runChecks`, `deploy`, `setWebhook`, `update`. Emits progress events.

- [ ] **Step 1: Write the implementation with mocked ssh2 in test**

```typescript
// betsy-app/src/main/ssh-bootstrap.ts
import { Client, ConnectConfig } from 'ssh2'
import { EventEmitter } from 'node:events'
import { generateEnv, type EnvParams } from './docker-compose-template.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SshCreds {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
}

export interface CheckResult {
  os: string
  hasDocker: boolean
  hasCompose: boolean
  diskFreeGb: number
  warnings: string[]
}

export class SshBootstrap extends EventEmitter {
  private client = new Client()
  private connected = false

  constructor(private creds: SshCreds, private resourcesDir: string) {
    super()
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const config: ConnectConfig = {
        host: this.creds.host,
        port: this.creds.port,
        username: this.creds.username,
      }
      if (this.creds.password) config.password = this.creds.password
      if (this.creds.privateKey) config.privateKey = this.creds.privateKey

      this.client.on('ready', () => {
        this.connected = true
        resolve()
      })
      this.client.on('error', (e) => reject(e))
      this.client.connect(config)
    })
  }

  disconnect() {
    if (this.connected) this.client.end()
    this.connected = false
  }

  async exec(cmd: string, opts: { stream?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      this.client.exec(cmd, (err, stream) => {
        if (err) return reject(err)
        let out = ''
        let errOut = ''
        stream.on('data', (d: Buffer) => {
          const s = d.toString()
          out += s
          if (opts.stream) this.emit('stdout', s)
        })
        stream.stderr.on('data', (d: Buffer) => {
          const s = d.toString()
          errOut += s
          if (opts.stream) this.emit('stderr', s)
        })
        stream.on('close', (code: number) => resolve({ code, stdout: out, stderr: errOut }))
      })
    })
  }

  async runChecks(): Promise<CheckResult> {
    const warnings: string[] = []
    const uname = await this.exec('uname -a')
    if (!uname.stdout.toLowerCase().includes('linux')) warnings.push('not-linux')

    const docker = await this.exec('docker --version || echo NO_DOCKER')
    const hasDocker = !docker.stdout.includes('NO_DOCKER')

    const compose = await this.exec('docker compose version || echo NO_COMPOSE')
    const hasCompose = !compose.stdout.includes('NO_COMPOSE')

    const df = await this.exec(`df -BG --output=avail / | tail -1`)
    const diskFreeGb = parseInt(df.stdout.trim().replace('G', ''), 10) || 0
    if (diskFreeGb < 10) warnings.push('low-disk')

    return {
      os: uname.stdout.trim(),
      hasDocker,
      hasCompose,
      diskFreeGb,
      warnings,
    }
  }

  async installDockerIfMissing(): Promise<void> {
    const check = await this.runChecks()
    if (check.hasDocker && check.hasCompose) return
    this.emit('progress', { pct: 5, log: 'Устанавливаю Docker...' })
    const inst = await this.exec(`curl -fsSL https://get.docker.com | sh`, { stream: true })
    if (inst.code !== 0) throw new Error(`docker install failed: ${inst.stderr}`)
  }

  async deploy(params: EnvParams): Promise<{ env: Record<string, string>; jwtSecret: string; dbPassword: string }> {
    await this.installDockerIfMissing()
    this.emit('progress', { pct: 15, log: 'Создаю /opt/betsy-multi' })
    await this.exec(`mkdir -p /opt/betsy-multi`)

    const tpl = readFileSync(join(this.resourcesDir, 'docker-compose.template.yml'), 'utf-8')
    const gen = generateEnv(params)

    this.emit('progress', { pct: 20, log: 'Заливаю compose-файл' })
    await this.writeRemote('/opt/betsy-multi/docker-compose.yml', tpl)
    await this.writeRemote('/opt/betsy-multi/.env', gen.asEnvFile)

    this.emit('progress', { pct: 30, log: 'docker compose pull...' })
    const pull = await this.exec(`cd /opt/betsy-multi && docker compose pull`, { stream: true })
    if (pull.code !== 0) throw new Error(`pull failed: ${pull.stderr}`)

    this.emit('progress', { pct: 75, log: 'docker compose up -d' })
    const up = await this.exec(`cd /opt/betsy-multi && docker compose up -d`, { stream: true })
    if (up.code !== 0) throw new Error(`up failed: ${up.stderr}`)

    this.emit('progress', { pct: 85, log: 'Ожидаю /healthz...' })
    const ok = await this.waitForHealth(params.publicUrl, 120_000)
    if (!ok) throw new Error('engine did not become healthy in 120s')

    this.emit('progress', { pct: 100, log: 'Готово' })
    return gen
  }

  private async waitForHealth(publicUrl: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const r = await this.exec(`curl -sf ${publicUrl}/healthz`)
      if (r.code === 0) return true
      await new Promise((res) => setTimeout(res, 2000))
    }
    return false
  }

  private writeRemote(path: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err)
        const stream = sftp.createWriteStream(path)
        stream.on('close', () => resolve())
        stream.on('error', reject)
        stream.end(content)
      })
    })
  }

  async setBotWebhook(botToken: string, publicUrl: string): Promise<void> {
    // The engine will call setWebhook on startup if BC_TG_BOT_TOKEN is set.
    // Here we just patch .env and restart.
    const envUpdate = `sed -i 's|^BC_TG_BOT_TOKEN=.*|BC_TG_BOT_TOKEN=${botToken}|' /opt/betsy-multi/.env`
    await this.exec(envUpdate)
    const restart = await this.exec(`cd /opt/betsy-multi && docker compose restart betsy`)
    if (restart.code !== 0) throw new Error(`restart failed: ${restart.stderr}`)
  }

  async updateEngine(): Promise<void> {
    this.emit('progress', { pct: 0, log: 'Pulling new image...' })
    const pull = await this.exec(`cd /opt/betsy-multi && docker compose pull`, { stream: true })
    if (pull.code !== 0) throw new Error(`update pull failed: ${pull.stderr}`)
    this.emit('progress', { pct: 80, log: 'Restarting...' })
    const up = await this.exec(`cd /opt/betsy-multi && docker compose up -d`, { stream: true })
    if (up.code !== 0) throw new Error(`update up failed: ${up.stderr}`)
    this.emit('progress', { pct: 100, log: 'Готово' })
  }
}
```

- [ ] **Step 2: Write unit test with mock ssh2**

```typescript
// betsy-app/tests/unit/ssh-bootstrap.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('ssh2', () => {
  class FakeStream extends EventEmitter {
    stderr = new EventEmitter()
    end() {}
  }
  class FakeClient extends EventEmitter {
    private _cmds: { cmd: string; stdout: string; stderr: string; code: number }[] = []
    setMockExec(matches: typeof this._cmds) { this._cmds = matches }
    connect() { setImmediate(() => this.emit('ready')) }
    end() {}
    exec(cmd: string, cb: (err: any, stream: FakeStream) => void) {
      const match = this._cmds.find((m) => cmd.includes(m.cmd))
      const stream = new FakeStream()
      cb(null, stream)
      setImmediate(() => {
        if (match) {
          if (match.stdout) stream.emit('data', Buffer.from(match.stdout))
          if (match.stderr) stream.stderr.emit('data', Buffer.from(match.stderr))
          stream.emit('close', match.code)
        } else {
          stream.emit('close', 0)
        }
      })
    }
    sftp(cb: (err: any, sftp: any) => void) {
      cb(null, {
        createWriteStream: () => {
          const s = new EventEmitter() as any
          s.end = () => setImmediate(() => s.emit('close'))
          return s
        },
      })
    }
  }
  return { Client: FakeClient }
})

import { SshBootstrap } from '../../src/main/ssh-bootstrap.js'

describe('SshBootstrap', () => {
  let bootstrap: SshBootstrap
  beforeEach(() => {
    bootstrap = new SshBootstrap(
      { host: 'h', port: 22, username: 'u', password: 'p' },
      './resources-mock',
    )
  })

  it('connect() resolves on ready', async () => {
    await expect(bootstrap.connect()).resolves.toBeUndefined()
  })

  it('runChecks() returns hasDocker=true when docker present', async () => {
    await bootstrap.connect()
    ;(bootstrap as any).client.setMockExec([
      { cmd: 'uname -a', stdout: 'Linux ubuntu 6.0\n', stderr: '', code: 0 },
      { cmd: 'docker --version', stdout: 'Docker version 24.0\n', stderr: '', code: 0 },
      { cmd: 'docker compose version', stdout: 'compose v2\n', stderr: '', code: 0 },
      { cmd: 'df -BG', stdout: '  50G\n', stderr: '', code: 0 },
    ])
    const c = await bootstrap.runChecks()
    expect(c.hasDocker).toBe(true)
    expect(c.hasCompose).toBe(true)
    expect(c.diskFreeGb).toBeGreaterThanOrEqual(40)
    expect(c.warnings).not.toContain('low-disk')
  })

  it('runChecks() warns on low disk', async () => {
    await bootstrap.connect()
    ;(bootstrap as any).client.setMockExec([
      { cmd: 'uname -a', stdout: 'Linux\n', stderr: '', code: 0 },
      { cmd: 'docker --version', stdout: 'Docker\n', stderr: '', code: 0 },
      { cmd: 'docker compose version', stdout: 'v2\n', stderr: '', code: 0 },
      { cmd: 'df -BG', stdout: '  3G\n', stderr: '', code: 0 },
    ])
    const c = await bootstrap.runChecks()
    expect(c.warnings).toContain('low-disk')
  })

  it('emits progress events during deploy', async () => {
    await bootstrap.connect()
    ;(bootstrap as any).client.setMockExec([
      { cmd: 'uname -a', stdout: 'Linux\n', stderr: '', code: 0 },
      { cmd: 'docker --version', stdout: 'v24\n', stderr: '', code: 0 },
      { cmd: 'docker compose version', stdout: 'v2\n', stderr: '', code: 0 },
      { cmd: 'df -BG', stdout: '  50G\n', stderr: '', code: 0 },
      { cmd: 'curl -sf', stdout: 'ok', stderr: '', code: 0 },
    ])
    // need to stub readFileSync for resourcesDir
    vi.mock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return { ...actual, readFileSync: () => 'version: 3.9\n' }
    })

    const events: any[] = []
    bootstrap.on('progress', (e) => events.push(e))
    await bootstrap.deploy({ presetId: 'betsy-default', publicUrl: 'http://1.2.3.4:3777' })
    const pcts = events.map((e) => e.pct)
    expect(pcts).toContain(15)
    expect(pcts).toContain(30)
    expect(pcts).toContain(100)
  })
})
```

- [ ] **Step 3: Run, expect pass**

```bash
cd betsy-app && npx vitest run tests/unit/ssh-bootstrap.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add betsy-app/src/main/ssh-bootstrap.ts betsy-app/tests/unit/ssh-bootstrap.test.ts
git commit -m "feat(betsy-app): SshBootstrap — checks + deploy + update via ssh2"
```

---

## Task 8: Secure storage wrapper (DPAPI via safeStorage)

**Files:**
- Create: `betsy-app/src/main/secure-storage.ts`

This is thin — wraps Electron's `safeStorage`. Hard to unit-test (depends on Electron runtime); covered by e2e instead.

- [ ] **Step 1: Implement**

```typescript
// betsy-app/src/main/secure-storage.ts
import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export class SecureStorage {
  constructor(private filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
  }

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  set(key: string, value: string): void {
    if (!this.isAvailable()) throw new Error('encryption unavailable on this OS')
    const all = this.loadAll()
    all[key] = safeStorage.encryptString(value).toString('base64')
    writeFileSync(this.filePath, JSON.stringify(all))
  }

  get(key: string): string | null {
    const all = this.loadAll()
    const enc = all[key]
    if (!enc) return null
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  }

  remove(key: string): void {
    const all = this.loadAll()
    delete all[key]
    writeFileSync(this.filePath, JSON.stringify(all))
  }

  private loadAll(): Record<string, string> {
    if (!existsSync(this.filePath)) return {}
    try { return JSON.parse(readFileSync(this.filePath, 'utf-8')) }
    catch { return {} }
  }
}
```

- [ ] **Step 2: Commit (no test — covered by e2e)**

```bash
git add betsy-app/src/main/secure-storage.ts
git commit -m "feat(betsy-app): SecureStorage wrapper (DPAPI via safeStorage)"
```

---

## Task 9: IPC bridge — main ↔ renderer

**Files:**
- Modify: `betsy-app/src/preload/preload.ts`
- Create: `betsy-app/src/main/ipc.ts`
- Create: `betsy-app/src/renderer/ipc.ts`

- [ ] **Step 1: Define IPC contract**

```typescript
// betsy-app/src/main/ipc.ts
import { ipcMain } from 'electron'
import type { WizardState, WizardEvent } from './wizard-engine.js'

export interface IpcContract {
  'persona:list': () => Promise<any[]>
  'persona:avatarPath': (id: string) => Promise<string | null>
  'wizard:getState': () => Promise<WizardState>
  'wizard:dispatch': (event: WizardEvent) => Promise<WizardState>
  'hosted:startLogin': (presetId: string) => Promise<{ nonce: string; deepLink: string }>
  'hosted:openExternal': (url: string) => Promise<void>
  'ssh:connect': (creds: any) => Promise<{ ok: true } | { ok: false; error: string }>
  'ssh:deploy': (params: any) => Promise<{ ok: boolean; error?: string }>
  'ssh:setBotWebhook': (token: string, publicUrl: string) => Promise<{ ok: boolean; error?: string }>
  'chat:send': (text: string) => Promise<void>
  'chat:onMessage': (cb: (msg: any) => void) => () => void
  // ...
}

// example registration — actual wiring done in index.ts
export function registerIpcHandlers(handlers: Partial<{ [K in keyof IpcContract]: IpcContract[K] }>) {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_e, ...args) => (handler as any)(...args))
  }
}
```

- [ ] **Step 2: Update preload**

```typescript
// betsy-app/src/preload/preload.ts
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, cb: (data: any) => void) => {
    const listener = (_e: any, data: any) => cb(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.off(channel, listener)
  },
})
```

- [ ] **Step 3: Typed renderer wrapper**

```typescript
// betsy-app/src/renderer/ipc.ts
import type { IpcContract } from '../main/ipc.js'

declare global {
  interface Window {
    api: {
      invoke<C extends keyof IpcContract>(channel: C, ...args: Parameters<IpcContract[C]>): ReturnType<IpcContract[C]>
      on(channel: string, cb: (data: any) => void): () => void
    }
  }
}

export const api = window.api
```

- [ ] **Step 4: Commit**

```bash
git add betsy-app/src/preload/preload.ts betsy-app/src/main/ipc.ts betsy-app/src/renderer/ipc.ts
git commit -m "feat(betsy-app): typed IPC bridge between main and renderer"
```

---

## Task 10: Renderer wizard shell + PersonaPicker

**Files:**
- Create: `betsy-app/src/renderer/wizard/WizardShell.tsx`
- Create: `betsy-app/src/renderer/wizard/PersonaPicker.tsx`
- Modify: `betsy-app/src/renderer/App.tsx`

- [ ] **Step 1: WizardShell**

```tsx
// betsy-app/src/renderer/wizard/WizardShell.tsx
import type { ReactNode } from 'react'
import type { WizardState } from '../../main/wizard-engine.js'

export function WizardShell({ state, avatarPath, children }: { state: WizardState; avatarPath: string | null; children: ReactNode }) {
  const showPersonaHeader = state.step !== 'persona-picker'
  const lines = (state as any).wizardLines  // populated externally by container

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {showPersonaHeader && avatarPath && (
        <header className="flex items-center gap-3 p-4 border-b border-neutral-800">
          <img src={`file://${avatarPath}`} alt="" className="w-12 h-12 rounded-full object-cover" />
          <div className="text-sm text-neutral-300">
            {/* line for current step is injected by step component */}
          </div>
        </header>
      )}
      <main className="p-6 max-w-3xl mx-auto">{children}</main>
    </div>
  )
}
```

- [ ] **Step 2: PersonaPicker**

```tsx
// betsy-app/src/renderer/wizard/PersonaPicker.tsx
import { useEffect, useState } from 'react'
import { api } from '../ipc.js'

export function PersonaPicker({ onSelect }: { onSelect: (presetId: string) => void }) {
  const [presets, setPresets] = useState<any[]>([])
  const [avatars, setAvatars] = useState<Record<string, string | null>>({})

  useEffect(() => {
    api.invoke('persona:list').then(async (list) => {
      setPresets(list)
      const av: Record<string, string | null> = {}
      for (const p of list) av[p.id] = await api.invoke('persona:avatarPath', p.id)
      setAvatars(av)
    })
  }, [])

  return (
    <div>
      <h1 className="text-2xl mb-2">Привет, я Бетси.</h1>
      <p className="text-neutral-400 mb-6">Выбери, какой ассистент тебе ближе.</p>
      <div className="grid grid-cols-2 gap-4">
        {presets.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className="p-5 border border-neutral-800 rounded-xl hover:border-neutral-600 text-left"
          >
            {avatars[p.id] && (
              <img src={`file://${avatars[p.id]}`} alt="" className="w-20 h-20 rounded-full mb-3" />
            )}
            <div className="text-lg font-medium">{p.name}</div>
            <div className="text-sm text-neutral-400 mt-1">{p.biography}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: App.tsx as wizard router**

```tsx
// betsy-app/src/renderer/App.tsx
import { useEffect, useState } from 'react'
import { api } from './ipc.js'
import { PersonaPicker } from './wizard/PersonaPicker.js'
import type { WizardState } from '../main/wizard-engine.js'

export function App() {
  const [state, setState] = useState<WizardState | null>(null)

  useEffect(() => { api.invoke('wizard:getState').then(setState) }, [])
  if (!state) return <div className="p-6 text-neutral-400">Загрузка…</div>

  if (state.step === 'persona-picker') {
    return (
      <PersonaPicker onSelect={async (presetId) => {
        const next = await api.invoke('wizard:dispatch', { type: 'persona-selected', presetId })
        setState(next)
      }} />
    )
  }
  // TODO subsequent steps in following tasks
  return <div className="p-6">Step: {state.step}</div>
}
```

- [ ] **Step 4: Wire main process for the IPC channels used above**

In `betsy-app/src/main/index.ts`, after app.whenReady, set up wizard engine instance + register IPC:

```typescript
import { reduce, initialState, type WizardState, type WizardEvent } from './wizard-engine.js'
import { PersonaCache } from './persona-cache.js'
import { registerIpcHandlers } from './ipc.js'
import { app } from 'electron'

let wizardState: WizardState = initialState()
const cache = new PersonaCache(
  join(app.getPath('userData'), 'persona-cache'),
  process.env.BC_API_BASE ?? 'https://api.betsyai.io',
)

app.whenReady().then(async () => {
  if (!cache.hasAny()) await cache.refresh()
  registerIpcHandlers({
    'persona:list': async () => cache.list(),
    'persona:avatarPath': async (id) => cache.getAvatarPath(id),
    'wizard:getState': async () => wizardState,
    'wizard:dispatch': async (e: WizardEvent) => {
      wizardState = reduce(wizardState, e)
      return wizardState
    },
  })
  createWindow()
})
```

- [ ] **Step 5: Manual sanity run**

```bash
cd betsy-app && BC_API_BASE=https://api-staging.betsyai.io npm run build && npm start
```

Expected: window opens, persona picker shows 2 cards from staging backend.

- [ ] **Step 6: Commit**

```bash
git add betsy-app/src/main/index.ts betsy-app/src/renderer/
git commit -m "feat(betsy-app): PersonaPicker + wizard shell + IPC wiring"
```

---

## Task 11: ModeSelect screen

**Files:**
- Create: `betsy-app/src/renderer/wizard/ModeSelect.tsx`
- Modify: `betsy-app/src/renderer/App.tsx`

- [ ] **Step 1: Component**

```tsx
// betsy-app/src/renderer/wizard/ModeSelect.tsx
export function ModeSelect({
  preset,
  onSelect,
}: {
  preset: any
  onSelect: (mode: 'hosted' | 'selfhost') => void
}) {
  const lines = preset.wizardLines
  return (
    <div>
      <p className="text-emerald-300 italic mb-6">«{lines.mode_intro}»</p>
      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => onSelect('hosted')}
          className="p-6 border border-neutral-800 rounded-xl hover:border-emerald-500 text-left"
        >
          <div className="text-xl mb-2">🌐 Хостим у нас</div>
          <div className="text-sm text-neutral-400">{lines.mode_hosted_pitch ?? 'подписка'}</div>
          <ul className="mt-4 text-sm space-y-1 text-neutral-300">
            <li>✓ ничего не нужно</li>
            <li>✓ работает за 2 минуты</li>
            <li>✓ обновления автоматические</li>
          </ul>
        </button>
        <button
          onClick={() => onSelect('selfhost')}
          className="p-6 border border-neutral-800 rounded-xl hover:border-amber-500 text-left"
        >
          <div className="text-xl mb-2">🖥️ На моём VPS</div>
          <div className="text-sm text-neutral-400">полная самостоятельность</div>
          <div className="mt-4 text-sm">
            <div className="text-neutral-400 mb-1">понадобится:</div>
            <ul className="space-y-1 text-neutral-300">
              {lines.mode_selfhost_checklist.map((item: string) => (
                <li key={item}>☐ {item}</li>
              ))}
            </ul>
          </div>
        </button>
      </div>
      <p className="text-emerald-300 italic mt-6 text-sm">«{lines.mode_selfhost_hint}»</p>
    </div>
  )
}
```

- [ ] **Step 2: Add route in App.tsx**

```tsx
// inside App.tsx render
if (state.step === 'mode-select') {
  const preset = presets.find((p) => p.id === state.selectedPresetId)
  if (!preset) return null
  return <ModeSelect preset={preset} onSelect={async (mode) => {
    const next = await api.invoke('wizard:dispatch', { type: 'mode-selected', mode })
    setState(next)
  }} />
}
```

Refactor App.tsx to load presets once (move to a context or top-level state). Each step component receives the currently selected preset.

- [ ] **Step 3: Commit**

```bash
git add betsy-app/src/renderer/
git commit -m "feat(betsy-app): ModeSelect screen with persona-driven copy + checklist"
```

---

## Task 12: Hosted wizard screens

**Files:**
- Create: `betsy-app/src/renderer/wizard/hosted/HostedLogin.tsx`
- Create: `betsy-app/src/renderer/wizard/hosted/HostedWaiting.tsx`
- Modify: `betsy-app/src/main/index.ts` (HostedAuth wiring)
- Modify: `betsy-app/src/renderer/App.tsx`

- [ ] **Step 1: Wire HostedAuth in main**

```typescript
// betsy-app/src/main/index.ts (additions)
import { HostedAuth } from './hosted-auth.js'
import { shell } from 'electron'

const hostedAuth = new HostedAuth(process.env.BC_API_BASE ?? 'https://api.betsyai.io')

// add IPC handlers:
registerIpcHandlers({
  // ...previous handlers...
  'hosted:startLogin': async (presetId) => {
    const r = await hostedAuth.start(presetId)
    wizardState = reduce(wizardState, { type: 'hosted-nonce-received', nonce: r.nonce, deepLink: r.deepLink })
    // kick off polling in background
    void runPollLoop(r.nonce)
    return { nonce: r.nonce, deepLink: r.deepLink }
  },
  'hosted:openExternal': async (url) => { await shell.openExternal(url) },
})

async function runPollLoop(nonce: string) {
  for (let i = 0; i < 12; i++) {  // 12 * 30s = 6 min max
    const r = await hostedAuth.poll(nonce, 30_000)
    if (r.kind === 'completed') {
      wizardState = reduce(wizardState, { type: 'hosted-poll-success', jwt: r.jwt, workspaceId: r.workspaceId })
      // notify renderer via push event
      mainWindow?.webContents.send('wizard:state-changed', wizardState)
      return
    }
    if (r.kind === 'expired') {
      wizardState = reduce(wizardState, { type: 'hosted-poll-timeout' })
      mainWindow?.webContents.send('wizard:state-changed', wizardState)
      return
    }
    if (r.kind === 'error') break
    // kind === 'timeout' — continue loop
  }
}
```

Renderer subscribes to `wizard:state-changed` to refresh state.

- [ ] **Step 2: HostedLogin.tsx**

```tsx
// betsy-app/src/renderer/wizard/hosted/HostedLogin.tsx
import { api } from '../../ipc.js'

export function HostedLogin({ preset, onStarted }: { preset: any; onStarted: () => void }) {
  const lines = preset.wizardLines
  const click = async () => {
    const r = await api.invoke('hosted:startLogin', preset.id)
    await api.invoke('hosted:openExternal', r.deepLink)
    onStarted()
  }
  return (
    <div>
      <p className="text-blue-300 italic mb-6">«{lines.tg_login_intro}»</p>
      <button
        onClick={click}
        className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg"
      >
        Войти через Telegram →
      </button>
    </div>
  )
}
```

- [ ] **Step 3: HostedWaiting.tsx**

```tsx
// betsy-app/src/renderer/wizard/hosted/HostedWaiting.tsx
export function HostedWaiting({ preset, deepLink }: { preset: any; deepLink: string }) {
  const lines = preset.wizardLines
  return (
    <div>
      <p className="text-blue-300 italic mb-6">«{lines.tg_login_waiting}»</p>
      <div className="bg-neutral-900 p-4 rounded text-sm text-neutral-400 mb-4">
        Не открылось? Скопируй ссылку:
        <div className="font-mono text-xs mt-2">{deepLink}</div>
        <button onClick={() => navigator.clipboard.writeText(deepLink)} className="mt-2 text-xs underline">
          Скопировать
        </button>
      </div>
      <div className="flex gap-2 items-center text-sm text-neutral-500">
        <div className="animate-pulse">●</div>
        Жду подключения...
      </div>
    </div>
  )
}
```

- [ ] **Step 4: App.tsx routing for both screens**

Add cases in App.tsx for `hosted-login` and `hosted-waiting` steps. Subscribe to `wizard:state-changed` push events.

- [ ] **Step 5: Commit**

```bash
git add betsy-app/src/main/index.ts betsy-app/src/renderer/
git commit -m "feat(betsy-app): hosted-login + hosted-waiting screens + poll loop"
```

---

## Task 13: Self-host wizard screens

**Files:**
- Create: `betsy-app/src/renderer/wizard/selfhost/SshForm.tsx`
- Create: `betsy-app/src/renderer/wizard/selfhost/InstallProgress.tsx`
- Create: `betsy-app/src/renderer/wizard/selfhost/BotTokenForm.tsx`
- Modify: `betsy-app/src/main/index.ts` (SshBootstrap wiring + IPC)
- Modify: `betsy-app/src/renderer/App.tsx`

- [ ] **Step 1: Wire SshBootstrap in main**

```typescript
// betsy-app/src/main/index.ts (additions)
import { SshBootstrap } from './ssh-bootstrap.js'
import { SecureStorage } from './secure-storage.js'
import { join } from 'node:path'
import { app } from 'electron'

const secureStorage = new SecureStorage(join(app.getPath('userData'), 'secure.json'))
let activeBootstrap: SshBootstrap | null = null

registerIpcHandlers({
  // ...
  'ssh:connect': async (creds: any) => {
    activeBootstrap = new SshBootstrap(creds, app.isPackaged ? process.resourcesPath : 'resources')
    activeBootstrap.on('progress', (e) => mainWindow?.webContents.send('install:progress', e))
    activeBootstrap.on('stdout', (s) => mainWindow?.webContents.send('install:log', s))
    try {
      await activeBootstrap.connect()
      return { ok: true as const }
    } catch (e: any) {
      return { ok: false as const, error: String(e.message ?? e) }
    }
  },
  'ssh:deploy': async (params) => {
    if (!activeBootstrap) return { ok: false, error: 'not-connected' }
    try {
      const gen = await activeBootstrap.deploy(params)
      // save credentials for future updates
      if (params.saveCreds) {
        secureStorage.set('ssh', JSON.stringify({ host: params.host, port: params.port, user: params.user /* no password — re-prompt */ }))
      }
      wizardState = reduce(wizardState, { type: 'install-done' })
      mainWindow?.webContents.send('wizard:state-changed', wizardState)
      return { ok: true }
    } catch (e: any) {
      wizardState = reduce(wizardState, { type: 'install-failed', error: String(e.message ?? e) })
      mainWindow?.webContents.send('wizard:state-changed', wizardState)
      return { ok: false, error: String(e.message ?? e) }
    }
  },
  'ssh:setBotWebhook': async (token, publicUrl) => {
    if (!activeBootstrap) return { ok: false, error: 'not-connected' }
    try {
      await activeBootstrap.setBotWebhook(token, publicUrl)
      wizardState = reduce(wizardState, { type: 'bot-webhook-ok' })
      mainWindow?.webContents.send('wizard:state-changed', wizardState)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e.message ?? e) }
    }
  },
})
```

- [ ] **Step 2: SshForm.tsx**

```tsx
// betsy-app/src/renderer/wizard/selfhost/SshForm.tsx
import { useState } from 'react'
import { api } from '../../ipc.js'

export function SshForm({ preset, onSubmitted }: { preset: any; onSubmitted: (params: any) => void }) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('root')
  const [authKind, setAuthKind] = useState<'password' | 'key'>('password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [saveCreds, setSaveCreds] = useState(true)
  const lines = preset.wizardLines

  const submit = async () => {
    setTesting(true)
    setError(null)
    const creds = { host, port: parseInt(port), username: user, password: authKind === 'password' ? password : undefined, privateKey: authKind === 'key' ? privateKey : undefined }
    const r = await api.invoke('ssh:connect', creds)
    setTesting(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    await api.invoke('wizard:dispatch', { type: 'ssh-creds-submitted', host, port: parseInt(port), user, authKind })
    onSubmitted({ host, port: parseInt(port), user, authKind, saveCreds })
  }

  return (
    <div>
      <p className="text-amber-300 italic mb-6">«{lines.ssh_prompt}»</p>
      <div className="space-y-3 max-w-md">
        <div className="flex gap-2">
          <input className="flex-1 bg-neutral-900 p-2 rounded" placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
          <input className="w-20 bg-neutral-900 p-2 rounded" placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
        <input className="w-full bg-neutral-900 p-2 rounded" placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
        <div className="flex gap-3 text-sm">
          <label><input type="radio" checked={authKind === 'password'} onChange={() => setAuthKind('password')} /> Пароль</label>
          <label><input type="radio" checked={authKind === 'key'} onChange={() => setAuthKind('key')} /> Ключ</label>
        </div>
        {authKind === 'password' ? (
          <input type="password" className="w-full bg-neutral-900 p-2 rounded" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        ) : (
          <textarea className="w-full bg-neutral-900 p-2 rounded font-mono text-xs h-32" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..." value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} />
        )}
        <label className="text-sm text-neutral-400">
          <input type="checkbox" checked={saveCreds} onChange={(e) => setSaveCreds(e.target.checked)} /> Запомнить для обновлений (зашифровано DPAPI)
        </label>
        {error && <div className="text-red-400 text-sm">{error}</div>}
        <button onClick={submit} disabled={testing || !host} className="px-6 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded">
          {testing ? 'Проверяю...' : 'Проверить подключение'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: InstallProgress.tsx + BotTokenForm.tsx** — similar pattern, listen to `install:progress` and `install:log` events. Skipped here for brevity; copy SshForm structure.

- [ ] **Step 4: App.tsx routing for selfhost screens**

- [ ] **Step 5: Manual test against a local sshd-container**

```bash
docker run -d --name betsy-test-sshd -p 2222:22 -e PASSWORD=test linuxserver/openssh-server
# launch betsy-app, run wizard with host=localhost, port=2222, user=linuxserver.io, password=test
# verify it gets to deploy step (will fail to start engine — that's OK for now)
docker rm -f betsy-test-sshd
```

- [ ] **Step 6: Commit**

```bash
git add betsy-app/src/main/index.ts betsy-app/src/renderer/
git commit -m "feat(betsy-app): selfhost wizard screens (ssh form, install progress, bot token)"
```

---

## Task 14: Main chat window — minimal

**Files:**
- Create: `betsy-app/src/main/backend-connector.ts`
- Create: `betsy-app/src/renderer/chat/ChatWindow.tsx`
- Create: `betsy-app/src/renderer/chat/AvatarPanel.tsx`
- Create: `betsy-app/src/renderer/chat/MessageList.tsx`
- Modify: `betsy-app/src/renderer/App.tsx`

- [ ] **Step 1: BackendConnector**

```typescript
// betsy-app/src/main/backend-connector.ts
import WebSocket from 'ws'
import { EventEmitter } from 'node:events'

export class BackendConnector extends EventEmitter {
  private ws: WebSocket | null = null
  private reconnectMs = 1000
  private maxReconnectMs = 30_000
  private alive = true

  constructor(private url: string, private jwt: string) {
    super()
  }

  start() {
    this.connect()
  }

  stop() {
    this.alive = false
    this.ws?.close()
  }

  private connect() {
    this.ws = new WebSocket(this.url, { headers: { authorization: `Bearer ${this.jwt}` } })
    this.ws.on('open', () => {
      this.reconnectMs = 1000
      this.emit('open')
    })
    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        this.emit('message', msg)
      } catch {}
    })
    this.ws.on('close', () => {
      this.emit('close')
      if (this.alive) {
        setTimeout(() => this.connect(), this.reconnectMs)
        this.reconnectMs = Math.min(this.reconnectMs * 2, this.maxReconnectMs)
      }
    })
    this.ws.on('error', (e) => this.emit('error', e))
  }

  send(msg: any) {
    this.ws?.send(JSON.stringify(msg))
  }
}
```

Add `ws` and `@types/ws` to betsy-app deps.

- [ ] **Step 2: Wire connector in main + IPC**

```typescript
// betsy-app/src/main/index.ts (after wizard completes)
let connector: BackendConnector | null = null

function startConnector(jwt: string, mode: 'hosted' | 'selfhost', publicUrl?: string) {
  const wsUrl = mode === 'hosted'
    ? (process.env.BC_WS_URL ?? 'wss://api.betsyai.io/ws')
    : `ws://${new URL(publicUrl!).host}/ws`
  connector = new BackendConnector(wsUrl, jwt)
  connector.on('message', (msg) => mainWindow?.webContents.send('chat:message', msg))
  connector.on('open', () => mainWindow?.webContents.send('chat:status', 'connected'))
  connector.on('close', () => mainWindow?.webContents.send('chat:status', 'reconnecting'))
  connector.start()
}

registerIpcHandlers({
  // ...
  'chat:send': async (text: string) => {
    connector?.send({ type: 'user-message', text })
  },
})
```

After wizard completion event, call `startConnector(state.hostedJwt, 'hosted')` or the selfhost equivalent.

- [ ] **Step 3: ChatWindow / AvatarPanel / MessageList** — straightforward React. AvatarPanel shows persona avatar (200×200), MessageList displays Betsy/User messages, ChatWindow combines + input + Send button.

- [ ] **Step 4: Commit**

```bash
git add betsy-app/
git commit -m "feat(betsy-app): minimal chat window + WSS BackendConnector"
```

---

## Task 15: Control panel — Status + Persona + Danger zone

**Files:**
- Create: `betsy-app/src/renderer/control-panel/ControlPanel.tsx`
- Create: `betsy-app/src/renderer/control-panel/StatusTab.tsx`
- Create: `betsy-app/src/renderer/control-panel/PersonaTab.tsx`
- Create: `betsy-app/src/renderer/control-panel/EngineUpdateTab.tsx`
- Create: `betsy-app/src/renderer/control-panel/DangerZoneTab.tsx`
- Create: `betsy-app/src/main/engine-update.ts`

- [ ] **Step 1: EngineUpdate**

```typescript
// betsy-app/src/main/engine-update.ts
import { SshBootstrap } from './ssh-bootstrap.js'

export async function checkEngineUpdate(apiBase: string): Promise<{ current: string; latest: string; needsUpdate: boolean }> {
  const r = await fetch(`${apiBase}/updates/engine/latest.json`)
  if (!r.ok) throw new Error(`update check failed: ${r.status}`)
  const manifest = await r.json()
  // current version stored locally — wired by settings-store
  // for now placeholder: caller compares
  return manifest
}

export async function applyEngineUpdate(bootstrap: SshBootstrap): Promise<void> {
  await bootstrap.updateEngine()
}
```

- [ ] **Step 2-5: Control panel React components** — straightforward layout; ControlPanel is a modal with tab nav, each tab is a screen. DangerZoneTab includes "Снести Бетси с VPS" button — calls `ssh:exec docker compose down && rm -rf` with confirm dialog.

- [ ] **Step 6: Commit**

```bash
git add betsy-app/
git commit -m "feat(betsy-app): control panel with status/persona/update/danger tabs"
```

---

## Task 16: e2e tests (Playwright + Electron + mock backend)

**Files:**
- Create: `betsy-app/tests/e2e/helpers/electron-driver.ts`
- Create: `betsy-app/tests/e2e/helpers/mock-backend.ts`
- Create: `betsy-app/tests/e2e/wizard-hosted.test.ts`
- Create: `betsy-app/tests/e2e/wizard-selfhost.test.ts`
- Create: `betsy-app/playwright.config.ts`

- [ ] **Step 1: Mock backend**

```typescript
// betsy-app/tests/e2e/helpers/mock-backend.ts
import { createServer, Server } from 'node:http'

export interface MockBackend {
  url: string
  close: () => Promise<void>
  /** Simulate user clicking /start in Telegram. */
  simulateTelegramStart: () => void
}

export async function startMockBackend(): Promise<MockBackend> {
  let pendingNonce: string | null = null
  let completedJwt: string | null = null

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', `http://x`)
    if (req.method === 'GET' && url.pathname === '/catalog/personas') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify([
        {
          id: 'betsy-default', name: 'Бетси', gender: 'female', voiceId: 'A',
          defaultBehavior: { voice: 'auto', selfie: 'auto', video: 'auto' },
          biography: 'Тёплый помощник', defaultPersonalityPrompt: 'pp',
          avatar: { static: `http://localhost:${(server.address() as any).port}/fake-avatar.png` },
          wizardLines: { mode_intro: 'mode_intro', mode_selfhost_checklist: ['VPS'], mode_selfhost_hint: 'hint', tg_login_intro: 'login_intro', tg_login_waiting: 'wait', tg_login_success: 'ok', ssh_prompt: 'ssh', ssh_test_ok: 'ok', install_progress: 'progress', install_done: 'done', bot_token_prompt: 'token', bot_webhook_ok: 'ok', wizard_complete: 'complete' },
        },
      ]))
      return
    }
    if (req.method === 'GET' && url.pathname === '/fake-avatar.png') {
      res.setHeader('content-type', 'image/png')
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      return
    }
    if (req.method === 'POST' && url.pathname === '/auth/tg-link/start') {
      pendingNonce = 'test-nonce-' + Date.now()
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ nonce: pendingNonce, deepLink: `https://t.me/x?start=${pendingNonce}`, expiresIn: 300 }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/auth/tg-link/poll') {
      if (completedJwt) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jwt: completedJwt, workspaceId: 'ws-mock' }))
      } else {
        res.statusCode = 408
        res.end('{}')
      }
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, r))
  const port = (server.address() as any).port
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
    simulateTelegramStart: () => { completedJwt = 'mock-jwt' },
  }
}
```

- [ ] **Step 2: Electron driver**

```typescript
// betsy-app/tests/e2e/helpers/electron-driver.ts
import { _electron as electron, ElectronApplication, Page } from 'playwright'
import { join } from 'node:path'

export async function launch(env: Record<string, string>): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [join(__dirname, '..', '..', '..', 'dist', 'main', 'index.js')],
    env: { ...process.env, ...env },
  })
  const window = await app.firstWindow()
  return { app, window }
}
```

- [ ] **Step 3: hosted e2e test**

```typescript
// betsy-app/tests/e2e/wizard-hosted.test.ts
import { test, expect } from '@playwright/test'
import { startMockBackend, type MockBackend } from './helpers/mock-backend.js'
import { launch } from './helpers/electron-driver.js'

let backend: MockBackend
test.beforeEach(async () => { backend = await startMockBackend() })
test.afterEach(async () => { await backend.close() })

test('hosted happy path: persona → mode → tg login → done', async () => {
  const { app, window } = await launch({
    BC_API_BASE: backend.url,
    BC_WS_URL: 'ws://localhost:0/none',  // not exercised; we stop at done
    BETSY_E2E: '1',
  })

  await expect(window.locator('text=Привет, я Бетси')).toBeVisible()
  await window.locator('button:has-text("Бетси")').first().click()

  // mode select
  await expect(window.locator('text=mode_intro')).toBeVisible()
  await window.locator('button:has-text("Хостим у нас")').click()

  // hosted login
  await expect(window.locator('text=login_intro')).toBeVisible()
  await window.locator('button:has-text("Войти через Telegram")').click()

  // waiting screen
  await expect(window.locator('text=wait')).toBeVisible()

  // simulate user pressing /start
  backend.simulateTelegramStart()

  // wait for done step
  await expect(window.locator('text=complete')).toBeVisible({ timeout: 35_000 })

  await app.close()
})
```

- [ ] **Step 4: selfhost e2e** — boot a sshd-container in `beforeAll`, point wizard at it.

```yaml
# docker-compose for test infra
services:
  sshd:
    image: linuxserver/openssh-server
    environment:
      PASSWORD_ACCESS: 'true'
      USER_NAME: betsy
      USER_PASSWORD: betsy
    ports:
      - '2222:2222'
```

- [ ] **Step 5: playwright.config.ts**

```typescript
// betsy-app/playwright.config.ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  retries: 0,
  workers: 1,
})
```

- [ ] **Step 6: Run**

```bash
cd betsy-app && npm run build && npx playwright test
```

Expected: hosted scenario PASS. Selfhost may need sshd-container running.

- [ ] **Step 7: Commit**

```bash
git add betsy-app/tests/e2e/ betsy-app/playwright.config.ts
git commit -m "test(betsy-app): e2e wizard hosted + selfhost via mock backend"
```

---

## Task 17: electron-updater wrapper

**Files:**
- Create: `betsy-app/src/main/updater.ts`

- [ ] **Step 1: Implement**

```typescript
// betsy-app/src/main/updater.ts
import { autoUpdater } from 'electron-updater'
import { log } from './logger.js'
import { BrowserWindow } from 'electron'

export function setupAutoUpdate(window: BrowserWindow) {
  autoUpdater.logger = { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m), debug: () => {} } as any
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => window.webContents.send('updater:available', info))
  autoUpdater.on('update-downloaded', (info) => window.webContents.send('updater:downloaded', info))
  autoUpdater.on('error', (e) => log('error', 'updater', { err: String(e) }))

  // Check on launch + every 4h
  autoUpdater.checkForUpdates().catch(() => {})
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000)
}
```

Renderer shows toast on `updater:downloaded` with "Перезапустить?" → calls `autoUpdater.quitAndInstall()` via IPC.

- [ ] **Step 2: Wire in index.ts**

```typescript
// after window creation
import { setupAutoUpdate } from './updater.js'
if (app.isPackaged) setupAutoUpdate(win)
```

- [ ] **Step 3: Commit**

```bash
git add betsy-app/src/main/updater.ts betsy-app/src/main/index.ts
git commit -m "feat(betsy-app): electron-updater wrapper, check every 4h"
```

---

## Final checks

- [ ] **Run all unit tests** — `cd betsy-app && npm test` — green
- [ ] **Run e2e** — `npm run test:e2e` — hosted scenario green; selfhost gated on sshd-container
- [ ] **Build installer locally** — `npm run dist` — produces `release/Betsy-Setup-0.0.0.exe`
- [ ] **Smoke test installer** — install on a clean Windows VM, run, wizard opens
- [ ] **Update root README** with "Windows app" section (one paragraph pointing to `betsy-app/`)

---

## Notes for executor

- **`src/ui/` reuse:** the spec says renderer reuses existing `src/ui/`. In practice, copy the Tailwind config + design tokens; don't import directly across the monorepo boundary unless the existing webpack/vite setup supports it. Worst case, duplicate the shared styles in `betsy-app/src/renderer/styles.css`.
- **State machine — push events to renderer:** Wizard state is mutated in main process; renderer must subscribe to `wizard:state-changed` push events, not just call `wizard:getState` once.
- **Avatar URLs:** in P1.A the placeholder is `https://cdn.betsyai.io/presets/...`. PersonaCache will fail to fetch until P1.C ships the CDN. Use mock backend for e2e until then.
- **`BETSY_E2E=1`** flag (used in test launch env) — implement in main process to skip auto-updater and pin known random seeds if needed for deterministic tests.
- **Don't commit secrets:** any test creds (SSH password 'betsy', mock JWT) are fine to commit. Real `BC_JWT_SECRET` etc. never appear in this codebase.
- **Mac/Linux:** out of scope for P1. Skip the `mac:` and `linux:` configs in `electron-builder.json`.
