/**
 * Auto-update wiring around electron-updater.
 *
 * Reads `latest.yml` from `updates.betsyai.io/electron/win-x64/` (the
 * `publish` block in `electron-builder.json`). Downloads block-level
 * diffs (`.blockmap`) so subsequent updates are ~MBs, not the full
 * 85MB installer.
 *
 * Renderer interaction (via IPC):
 *   - PUSH 'updater:available'         { version }
 *   - PUSH 'updater:download-progress' { percent, bytesPerSecond }
 *   - PUSH 'updater:downloaded'        { version }
 *   - PUSH 'updater:error'             { message }
 *   - HANDLE 'updater:install-now' → autoUpdater.quitAndInstall()
 *   - HANDLE 'updater:check-now' → triggers a fresh check (used by Settings)
 *
 * In dev (`app.isPackaged === false`) the whole thing is a no-op.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { log } from './logger.js'

let mainWindowRef: BrowserWindow | null = null
let initialized = false

function send(channel: string, payload: unknown): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, payload)
  }
}

export function setupAutoUpdate(mainWindow: BrowserWindow): void {
  if (initialized) {
    mainWindowRef = mainWindow
    return
  }
  initialized = true
  mainWindowRef = mainWindow

  if (!app.isPackaged) {
    log('info', 'updater: dev build, skipping auto-update')
    return
  }

  autoUpdater.logger = {
    info: (m: string) => log('info', `updater: ${m}`),
    warn: (m: string) => log('warn', `updater: ${m}`),
    error: (m: string) => log('error', `updater: ${m}`),
    debug: () => {},
  } as never

  // Download diffs automatically once available — renderer just gets the
  // "ready to restart" notification.
  autoUpdater.autoDownload = true
  // Don't quit-and-install on app close without explicit user consent;
  // they should see the banner and click "Перезапустить".
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('update-available', (info) => {
    log('info', 'updater: update-available', { version: info.version })
    send('updater:available', { version: info.version })
  })

  autoUpdater.on('download-progress', (p) => {
    send('updater:download-progress', {
      percent: Math.round(p.percent),
      bytesPerSecond: p.bytesPerSecond,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log('info', 'updater: update-downloaded', { version: info.version })
    send('updater:downloaded', { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    log('warn', 'updater: error', { error: err instanceof Error ? err.message : String(err) })
    send('updater:error', { message: err instanceof Error ? err.message : String(err) })
  })

  ipcMain.handle('updater:install-now', () => {
    log('info', 'updater: install-now requested by user')
    setImmediate(() => autoUpdater.quitAndInstall())
  })

  ipcMain.handle('updater:check-now', async () => {
    try {
      const r = await autoUpdater.checkForUpdates()
      return { ok: true, version: r?.updateInfo?.version ?? null }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // First check after a short delay (let the window finish loading); then
  // every hour while the app is running. Also re-check when the window gets
  // refocused after >5 minutes idle — covers laptop sleep / long unfocused
  // sessions where the interval timer may have skipped.
  let lastCheckAt = 0
  function check(reason: string): void {
    lastCheckAt = Date.now()
    autoUpdater.checkForUpdates().catch((e) =>
      log('warn', 'updater: check failed', {
        reason,
        error: e instanceof Error ? e.message : String(e),
      }),
    )
  }
  setTimeout(() => check('initial'), 10_000)
  setInterval(() => check('hourly'), 60 * 60 * 1000)
  mainWindow.on('focus', () => {
    if (Date.now() - lastCheckAt > 5 * 60 * 1000) check('on-focus')
  })
}
