import { describe, expect, it } from 'vitest'
import { generateEnv } from '../../src/main/docker-compose-template'

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
    expect(env.BC_DATABASE_URL).toContain('postgres://betsy:')
    expect(env.BC_DATABASE_URL).toContain('@postgres:5432/betsy')
    expect(env.BC_WEBHOOK_BASE_URL).toBe('http://x:3777')
    expect(env.BC_PORT).toBe('3777')
    expect(env.BC_HTTP_PORT).toBe('3777')
    expect(env.BC_HEALTHZ_PORT).toBe('3777')
    expect(env.BC_ENGINE_VERSION).toBe('latest')
    expect(env.BC_TELEGRAM_BOT_TOKEN).toBe('') // empty until bot step
    expect(env.GEMINI_API_KEY).toBe('') // empty until user provides
  })

  it('asEnvFile is valid .env format', () => {
    const { asEnvFile } = generateEnv({ presetId: 'betsy-default', publicUrl: 'http://x' })
    expect(asEnvFile).toMatch(/^BC_DB_PASSWORD=.+$/m)
    expect(asEnvFile.endsWith('\n')).toBe(true)
    expect(asEnvFile).not.toMatch(/^=$/m)
  })

  it('respects optional port + botToken + geminiApiKey + engineVersion', () => {
    const { env } = generateEnv({
      presetId: 'p',
      publicUrl: 'http://x',
      port: 4000,
      botToken: '123:abc',
      geminiApiKey: 'gem-key',
      engineVersion: 'v1.2.3',
    })
    expect(env.BC_PORT).toBe('4000')
    expect(env.BC_HTTP_PORT).toBe('4000')
    expect(env.BC_HEALTHZ_PORT).toBe('4000')
    expect(env.BC_TELEGRAM_BOT_TOKEN).toBe('123:abc')
    expect(env.GEMINI_API_KEY).toBe('gem-key')
    expect(env.BC_ENGINE_VERSION).toBe('v1.2.3')
  })

  it('omits the dead BC_TG_BOT_TOKEN / BC_PERSONA_PRESET_ID / BC_PUBLIC_URL keys', () => {
    // Regression guard: these used to be in the .env but the engine never
    // read them (or read them under a different name). Keep them out so the
    // wizard ships the same shape as the engine validates.
    const { env } = generateEnv({ presetId: 'betsy-default', publicUrl: 'http://x' })
    expect(env.BC_TG_BOT_TOKEN).toBeUndefined()
    expect(env.BC_PERSONA_PRESET_ID).toBeUndefined()
    expect(env.BC_PUBLIC_URL).toBeUndefined()
  })
})
