export type WizardStep =
  | 'persona-picker'
  | 'mode-select'
  | 'hosted-login' // shows "click to open Telegram"
  | 'hosted-waiting' // polling /auth/tg-link/poll
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
  installProgress: number // 0..100
  installLog: string[]
  installError: string | null
  hostedError: string | null
  botToken: string | null
  botWebhookOk: boolean
}

export type WizardEvent =
  | { type: 'persona-selected'; presetId: string }
  | { type: 'mode-selected'; mode: 'hosted' | 'selfhost' }
  | { type: 'hosted-nonce-received'; nonce: string; deepLink: string }
  | { type: 'hosted-poll-success'; jwt: string; workspaceId: string }
  | { type: 'hosted-poll-timeout' }
  | { type: 'hosted-poll-error'; message: string }
  | {
      type: 'ssh-creds-submitted'
      host: string
      port: number
      user: string
      authKind: 'password' | 'key'
    }
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
    hostedError: null,
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
      // Fresh login attempt — clear any prior poll error so the user isn't
      // looking at a stale message while waiting for the new flow.
      return {
        ...state,
        hostedNonce: event.nonce,
        hostedDeepLink: event.deepLink,
        hostedError: null,
        step: 'hosted-waiting',
      }
    case 'hosted-poll-success':
      return {
        ...state,
        hostedJwt: event.jwt,
        hostedWorkspaceId: event.workspaceId,
        step: 'done',
      }
    case 'hosted-poll-timeout':
      return { ...state, step: 'hosted-login' }
    case 'hosted-poll-error':
      return { ...state, step: 'hosted-login', hostedError: event.message }
    case 'ssh-creds-submitted':
      return {
        ...state,
        sshHost: event.host,
        sshPort: event.port,
        sshUser: event.user,
        sshAuthKind: event.authKind,
        step: 'selfhost-install',
      }
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
  return { ...state, step: order[idx - 1]! }
}
