import { app, BrowserWindow, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { log } from './logger'
import { reduce, initialState, type WizardState, type WizardEvent } from './wizard-engine'
import { PersonaCache } from './persona-cache'
import { registerIpcHandlers, type SshCredsDto, type DeployParamsDto } from './ipc'
import { HostedAuth } from './hosted-auth'
import { SshBootstrap } from './ssh-bootstrap'
import { SecureStorage } from './secure-storage'
import { BackendConnector } from './backend-connector'
import { ChatHistoryClient } from './chat-history-client'
import { setupAutoUpdate } from './updater'
import type { ClientMessage, ServerMessage } from '../shared/chat-protocol'

const isDev = !!process.env.VITE_DEV_SERVER_URL
const apiBase = process.env.BC_API_BASE ?? 'https://api.betsyai.io'

// Allow tests to override user-data location.
const userDataOverride = process.argv.find((a) => a.startsWith('--user-data-dir='))
if (userDataOverride) {
  app.setPath('userData', userDataOverride.slice('--user-data-dir='.length))
}

let mainWindow: BrowserWindow | null = null
let wizardState: WizardState = initialState()
let personaCache: PersonaCache | null = null
let secureStorage: SecureStorage | null = null
const hostedAuth = new HostedAuth(apiBase)
let activePollNonce: string | null = null
let activeBootstrap: SshBootstrap | null = null
let lastDeployedPublicUrl: string | null = null
let chatConnector: BackendConnector | null = null
let chatHistoryClient: ChatHistoryClient | null = null

function chatEngineBase(): string {
  if (wizardState.mode === 'hosted') return apiBase
  if (wizardState.mode === 'selfhost' && lastDeployedPublicUrl) return lastDeployedPublicUrl
  return apiBase
}

function startChatBackend(): void {
  if (!wizardState.hostedJwt) {
    log('warn', 'chat-start-without-jwt')
    return
  }
  const base = chatEngineBase()
  // Stop any previous connector before replacing (idempotent).
  if (chatConnector) {
    try {
      chatConnector.stop()
    } catch {
      // ignore
    }
    chatConnector = null
  }
  const wsUrl = base.replace(/^http/i, 'ws') + '/ws/chat'
  const connector = new BackendConnector({ url: wsUrl, jwt: wizardState.hostedJwt })
  chatHistoryClient = new ChatHistoryClient(base, wizardState.hostedJwt)

  connector.on('open', () => {
    mainWindow?.webContents.send('chat:connection', { status: 'open' })
  })
  connector.on('close', () => {
    mainWindow?.webContents.send('chat:connection', { status: 'reconnecting' })
  })
  connector.on('auth-failed', () => {
    mainWindow?.webContents.send('chat:connection', { status: 'auth-failed' })
  })
  connector.on('message', (msg: ServerMessage) => {
    mainWindow?.webContents.send('chat:event', msg)
  })

  // Tell renderer we're connecting before the WS opens (so banner shows
  // a "connecting" state instead of "auth-failed" leftover from a previous run).
  mainWindow?.webContents.send('chat:connection', { status: 'connecting' })
  connector.start()
  chatConnector = connector
}

function stopChatBackend(): void {
  if (chatConnector) {
    try {
      chatConnector.stop()
    } catch {
      // ignore
    }
    chatConnector = null
  }
  chatHistoryClient = null
}

function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..', 'resources')
}

function createWindow(): void {
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
    void win.loadURL(process.env.VITE_DEV_SERVER_URL!)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
}

function pushWizardState(): void {
  mainWindow?.webContents.send('wizard:state-changed', wizardState)
}

function dispatchInternal(event: WizardEvent): void {
  wizardState = reduce(wizardState, event)
  pushWizardState()
}

async function runPollLoop(nonce: string): Promise<void> {
  activePollNonce = nonce
  for (let i = 0; i < 12; i++) {
    if (activePollNonce !== nonce) return
    try {
      const r = await hostedAuth.poll(nonce, 30_000)
      if (activePollNonce !== nonce) return
      if (r.kind === 'completed') {
        dispatchInternal({
          type: 'hosted-poll-success',
          jwt: r.jwt,
          workspaceId: r.workspaceId,
        })
        activePollNonce = null
        return
      }
      if (r.kind === 'expired') {
        dispatchInternal({ type: 'hosted-poll-timeout' })
        activePollNonce = null
        return
      }
      if (r.kind === 'error') {
        log('warn', 'hosted-poll-error', { status: r.status })
        dispatchInternal({
          type: 'hosted-poll-error',
          message: `Сервер вернул ошибку при опросе (status ${r.status})`,
        })
        activePollNonce = null
        return
      }
    } catch (e) {
      log('warn', 'hosted-poll-throw', { err: String(e) })
      await new Promise((res) => setTimeout(res, 5_000))
    }
  }
  if (activePollNonce === nonce) {
    dispatchInternal({ type: 'hosted-poll-timeout' })
    activePollNonce = null
  }
}

void app.whenReady().then(async () => {
  log('info', 'app-ready', { apiBase })

  personaCache = new PersonaCache(join(app.getPath('userData'), 'persona-cache'), apiBase)
  secureStorage = new SecureStorage(join(app.getPath('userData'), 'secure.json'))

  if (!personaCache.hasAny()) {
    try {
      await personaCache.refresh()
    } catch (e) {
      log('error', 'persona-cache-refresh-failed', { err: String(e) })
    }
  } else {
    void personaCache.refresh().catch((e) => {
      log('warn', 'persona-cache-bg-refresh-failed', { err: String(e) })
    })
  }

  registerIpcHandlers({
    'persona:list': async () => personaCache!.list(),
    'persona:avatarPath': async (id: string) => personaCache!.getAvatarPath(id),
    'wizard:getState': async () => wizardState,
    'wizard:dispatch': async (event: WizardEvent) => {
      wizardState = reduce(wizardState, event)
      pushWizardState()
      // Reset chat backend when wizard is reset (re-auth flow).
      if (event.type === 'reset') {
        stopChatBackend()
      }
      return wizardState
    },
    'hosted:startLogin': async (presetId: string) => {
      const r = await hostedAuth.start(presetId)
      dispatchInternal({
        type: 'hosted-nonce-received',
        nonce: r.nonce,
        deepLink: r.deepLink,
      })
      void runPollLoop(r.nonce)
      return { nonce: r.nonce, deepLink: r.deepLink }
    },
    'hosted:openExternal': async (url: string) => {
      try {
        await shell.openExternal(url)
      } catch (e) {
        log('warn', 'open-external-failed', { url, err: String(e) })
        // non-fatal — user can copy the link from the waiting screen
      }
    },
    'ssh:connect': async (creds: SshCredsDto) => {
      activeBootstrap?.disconnect()
      activeBootstrap = new SshBootstrap(creds, resourcesDir())
      activeBootstrap.on('progress', (e) => {
        mainWindow?.webContents.send('install:progress', e)
        if (typeof (e as { pct?: number }).pct === 'number') {
          dispatchInternal({
            type: 'install-progress',
            pct: (e as { pct: number }).pct,
            logLine: (e as { log?: string }).log,
          })
        }
      })
      activeBootstrap.on('stdout', (s: string) => {
        mainWindow?.webContents.send('install:log', s)
      })
      activeBootstrap.on('stderr', (s: string) => {
        mainWindow?.webContents.send('install:log', s)
      })
      try {
        await activeBootstrap.connect()
        return { ok: true as const }
      } catch (e) {
        return { ok: false as const, error: String((e as Error).message ?? e) }
      }
    },
    'ssh:deploy': async (params: DeployParamsDto) => {
      if (!activeBootstrap) return { ok: false, error: 'not-connected' }
      try {
        const gen = await activeBootstrap.deploy({
          presetId: params.presetId,
          publicUrl: params.publicUrl,
          port: params.port,
          botToken: params.botToken,
          engineVersion: params.engineVersion,
        })
        lastDeployedPublicUrl = params.publicUrl
        if (params.saveCreds && params.host && params.user) {
          try {
            secureStorage!.set(
              'ssh',
              JSON.stringify({
                host: params.host,
                port: params.port ?? 22,
                user: params.user,
                dbPassword: gen.dbPassword,
              }),
            )
          } catch (e) {
            log('warn', 'secure-storage-save-failed', { err: String(e) })
          }
        }
        dispatchInternal({ type: 'install-done' })
        return { ok: true }
      } catch (e) {
        const msg = String((e as Error).message ?? e)
        dispatchInternal({ type: 'install-failed', error: msg })
        return { ok: false, error: msg }
      }
    },
    'ssh:setBotWebhook': async (token: string) => {
      if (!activeBootstrap) return { ok: false, error: 'not-connected' }
      try {
        await activeBootstrap.setBotWebhook(token)
        dispatchInternal({ type: 'bot-webhook-ok' })
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String((e as Error).message ?? e) }
      }
    },
    'ssh:setEngineEnv': async (params: { geminiApiKey: string }) => {
      if (!activeBootstrap) return { ok: false, error: 'not-connected' }
      try {
        await activeBootstrap.setEngineEnv(params)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String((e as Error).message ?? e) }
      }
    },
    'app:getInfo': async () => ({
      version: app.getVersion(),
      mode: wizardState.mode,
      engineUrl:
        wizardState.mode === 'hosted'
          ? apiBase
          : wizardState.mode === 'selfhost'
            ? lastDeployedPublicUrl
            : null,
    }),
    'chat:start': async () => {
      startChatBackend()
    },
    'chat:send': async (text: string) => {
      if (!chatConnector) throw new Error('chat-not-started')
      const msg: ClientMessage = {
        type: 'user-message',
        text,
        clientMessageId: randomUUID(),
      }
      chatConnector.send(msg)
    },
    'chat:history': async (opts: { before?: string; limit?: number }) => {
      if (!chatHistoryClient) throw new Error('chat-not-started')
      return chatHistoryClient.fetchHistory(opts)
    },
  })

  createWindow()

  // Auto-update: in packaged builds polls updates.betsyai.io every 4h,
  // downloads block-level diffs, pushes 'updater:downloaded' to renderer.
  // No-op in dev.
  if (mainWindow) setupAutoUpdate(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
