// Smoke test for the wizard env contract. Catches drift between the .env
// the Electron self-host wizard writes to /opt/betsy-multi/.env and the
// schema the multi-engine actually validates on boot. If this test fails,
// the wizard ships a broken VPS — engine won't start, user sees a docker
// crash loop and has no recourse short of SSH'ing in.
import { describe, expect, it } from 'vitest'
import { envSchema, parseEnv } from '../../../src/multi/env.js'
// Imports the wizard's env-generation contract directly from the Electron
// app source tree. Intentional cross-package import — the test's whole job
// is to keep these two trees in lockstep.
import { generateEnv } from '../../../betsy-app/src/main/wizard-env-contract'

const VALID_TG_TOKEN = '123456:abcdefghijklmnopqrstuvwxyzABCDEFGHIJK'

describe('wizard env contract', () => {
  it('generated env passes envSchema validation', () => {
    const { env } = generateEnv({
      presetId: 'betsy-default',
      publicUrl: 'http://1.2.3.4:3777',
      botToken: VALID_TG_TOKEN,
      geminiApiKey: 'fake-key',
    })
    // envSchema only enforces types; parseEnv adds cross-field checks.
    const parsed = envSchema.parse(env)
    expect(parsed.BC_DATABASE_URL).toContain('postgres://')
    expect(parsed.GEMINI_API_KEY).toBe('fake-key')
    expect(parsed.BC_TELEGRAM_BOT_TOKEN).toBe(VALID_TG_TOKEN)
    expect(parsed.BC_WEBHOOK_BASE_URL).toBe('http://1.2.3.4:3777')
    // Healthz port must match the public/API port so the wizard's probe
    // hits the right socket — see wizard-env-contract.ts for rationale.
    expect(parsed.BC_HEALTHZ_PORT).toBe(parsed.BC_HTTP_PORT)
  })

  it('generated env passes the full parseEnv (boot-time) check', () => {
    const { env } = generateEnv({
      presetId: 'betsy-default',
      publicUrl: 'http://1.2.3.4:3777',
      botToken: VALID_TG_TOKEN,
      geminiApiKey: 'fake-key',
    })
    expect(() => parseEnv(env)).not.toThrow()
  })

  it('generated env without GEMINI_API_KEY fails parseEnv (engine refuses to boot)', () => {
    const { env } = generateEnv({
      presetId: 'betsy-default',
      publicUrl: 'http://1.2.3.4:3777',
      botToken: VALID_TG_TOKEN,
      // geminiApiKey omitted on purpose
    })
    expect(() => parseEnv(env)).toThrow(/GEMINI_API_KEY/)
  })

  it('generated env without bot token fails parseEnv', () => {
    const { env } = generateEnv({
      presetId: 'betsy-default',
      publicUrl: 'http://1.2.3.4:3777',
      geminiApiKey: 'fake-key',
      // botToken omitted
    })
    expect(() => parseEnv(env)).toThrow(/BC_TELEGRAM_BOT_TOKEN/)
  })
})
