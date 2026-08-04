import { describe, expect, it } from 'vitest'
import { initialState, reduce } from '../../src/main/wizard-engine'

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
    s = reduce(s, {
      type: 'hosted-nonce-received',
      nonce: 'n1',
      deepLink: 'https://t.me/x?start=n1',
    })
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

  it('hosted poll error surfaces message on hosted-login screen', () => {
    let s = reduce(initialState(), { type: 'persona-selected', presetId: 'betsy-default' })
    s = reduce(s, { type: 'mode-selected', mode: 'hosted' })
    s = reduce(s, { type: 'hosted-nonce-received', nonce: 'n1', deepLink: 'x' })
    s = reduce(s, { type: 'hosted-poll-error', message: 'server 500' })
    expect(s.step).toBe('hosted-login')
    expect(s.hostedError).toBe('server 500')
  })

  it('hostedError clears when a new login starts', () => {
    let s = reduce(initialState(), { type: 'persona-selected', presetId: 'betsy-default' })
    s = reduce(s, { type: 'mode-selected', mode: 'hosted' })
    s = reduce(s, { type: 'hosted-nonce-received', nonce: 'n1', deepLink: 'x' })
    s = reduce(s, { type: 'hosted-poll-error', message: 'oops' })
    expect(s.hostedError).toBe('oops')
    s = reduce(s, { type: 'hosted-nonce-received', nonce: 'n2', deepLink: 'y' })
    expect(s.hostedError).toBeNull()
  })

  it('selfhost path: ssh → install → bot-token → done', () => {
    let s = reduce(initialState(), { type: 'persona-selected', presetId: 'betsy-default' })
    s = reduce(s, { type: 'mode-selected', mode: 'selfhost' })
    expect(s.step).toBe('selfhost-ssh-form')
    s = reduce(s, {
      type: 'ssh-creds-submitted',
      host: 'h',
      port: 22,
      user: 'u',
      authKind: 'key',
    })
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

  it('install-failed records error without changing step', () => {
    let s = reduce(initialState(), { type: 'persona-selected', presetId: 'betsy-default' })
    s = reduce(s, { type: 'mode-selected', mode: 'selfhost' })
    s = reduce(s, {
      type: 'ssh-creds-submitted',
      host: 'h',
      port: 22,
      user: 'u',
      authKind: 'password',
    })
    s = reduce(s, { type: 'install-failed', error: 'boom' })
    expect(s.installError).toBe('boom')
    expect(s.step).toBe('selfhost-install')
  })
})
