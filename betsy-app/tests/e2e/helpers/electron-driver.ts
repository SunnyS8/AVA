import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

export async function launch(
  env: Record<string, string>,
): Promise<{ app: ElectronApplication; window: Page; userDataDir: string }> {
  // Strip ELECTRON_RUN_AS_NODE from inherited env — it forces Electron to behave as plain
  // Node, which breaks `app.whenReady()`. Some dev harnesses (this one) set it globally.
  const baseEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'ELECTRON_RUN_AS_NODE') continue
    if (typeof v === 'string') baseEnv[k] = v
  }
  // Isolate user-data per test to avoid state bleed (persona-cache, secure-storage)
  const userDataDir = mkdtempSync(join(tmpdir(), 'betsy-e2e-'))
  const app = await electron.launch({
    args: [join(__dirname, '..', '..', '..', 'dist', 'main', 'index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...baseEnv, ...env, NODE_ENV: 'test' },
  })
  const window = await app.firstWindow()
  return { app, window, userDataDir }
}
