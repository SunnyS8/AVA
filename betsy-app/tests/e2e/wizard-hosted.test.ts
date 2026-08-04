import { test, expect } from '@playwright/test'
import { startMockBackend, type MockBackend } from './helpers/mock-backend'
import { launch } from './helpers/electron-driver'

let backend: MockBackend
test.beforeEach(async () => {
  backend = await startMockBackend()
})
test.afterEach(async () => {
  await backend.close()
})

test('hosted happy path: persona → mode → tg login → done', async () => {
  const { app, window } = await launch({
    BC_API_BASE: backend.url,
    BETSY_E2E: '1',
  })

  await expect(window.locator('text=Привет, я Бетси')).toBeVisible({ timeout: 15_000 })
  await window.locator('button:has-text("Бетси")').first().click()

  // mode select
  await expect(window.locator('text=mode_intro_line').first()).toBeVisible()
  await window.locator('button:has-text("Хостим у нас")').click()

  // hosted login
  await expect(window.locator('text=login_intro_line').first()).toBeVisible()
  // Programmatic invoke — bypass shell.openExternal which may misbehave in test env
  const startResult = await window.evaluate(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).api.invoke('hosted:startLogin', 'betsy-default')
      return { ok: true }
    } catch (e) {
      return { ok: false, err: String((e as Error).message ?? e) }
    }
  })
  expect(startResult.ok).toBe(true)

  // waiting screen — state transition pushed from main process
  await expect(window.locator('text=wait_line').first()).toBeVisible({ timeout: 15_000 })

  // simulate user pressing /start in Telegram
  backend.simulateTelegramStart()

  // wait for done step — stops at wizard:done per pre-flight finding #1
  await expect(window.locator('text=complete_line').first()).toBeVisible({ timeout: 60_000 })

  await app.close()
})
