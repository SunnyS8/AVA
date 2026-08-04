import { test, expect } from '@playwright/test'
import { startMockBackend, type MockBackend } from './helpers/mock-backend'
import { launch } from './helpers/electron-driver'

let backend: MockBackend
test.beforeEach(async () => {
  backend = await startMockBackend({ enableChatWs: true })
})
test.afterEach(async () => {
  await backend.close()
})

test('after wizard done: chat window opens, send works, streaming reply visible', async () => {
  const { app, window } = await launch({
    BC_API_BASE: backend.url,
    BETSY_E2E: '1',
  })

  // Walk through the hosted wizard to `done` — same flow as wizard-hosted.test.ts.
  await expect(window.locator('text=Привет, я Бетси')).toBeVisible({ timeout: 15_000 })
  await window.locator('button:has-text("Бетси")').first().click()
  await expect(window.locator('text=mode_intro_line').first()).toBeVisible()
  await window.locator('button:has-text("Хостим у нас")').click()
  await expect(window.locator('text=login_intro_line').first()).toBeVisible()

  // Programmatically kick off /auth/tg-link/start (bypasses shell.openExternal
  // which may misbehave in the test env).
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

  await expect(window.locator('text=wait_line').first()).toBeVisible({ timeout: 15_000 })
  backend.simulateTelegramStart()

  // ChatWindow should mount: the composer textarea is the most reliable hook.
  const composer = window.locator('textarea[placeholder*="Напиши"]').first()
  await expect(composer).toBeVisible({ timeout: 30_000 })

  // Send a user message.
  await composer.fill('тест-пишу-бетси')
  await window.locator('button[aria-label="Отправить"]').click()

  // Optimistic user bubble appears immediately.
  await expect(window.locator('text=тест-пишу-бетси')).toBeVisible()

  // Mock backend streams "ок" -> "окей" -> "окей, понял." -> final.
  await expect(window.locator('text=окей, понял.').first()).toBeVisible({ timeout: 5_000 })

  await app.close()
})
