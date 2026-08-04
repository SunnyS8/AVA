import type { WizardState, WizardEvent } from '../main/wizard-engine'
import type { CachedPreset } from '../main/persona-cache'
import type { Message } from './chat-protocol'

export interface SshCredsDto {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
}

export interface DeployParamsDto {
  presetId: string
  publicUrl: string
  port?: number
  botToken?: string
  engineVersion?: string
  saveCreds?: boolean
  host?: string
  user?: string
}

export interface AppInfo {
  version: string
  mode: 'hosted' | 'selfhost' | null
  engineUrl: string | null
}

export interface IpcContract {
  'persona:list': () => Promise<CachedPreset[]>
  'persona:avatarPath': (id: string) => Promise<string | null>
  'wizard:getState': () => Promise<WizardState>
  'wizard:dispatch': (event: WizardEvent) => Promise<WizardState>
  'hosted:startLogin': (presetId: string) => Promise<{ nonce: string; deepLink: string }>
  'hosted:openExternal': (url: string) => Promise<void>
  'ssh:connect': (creds: SshCredsDto) => Promise<{ ok: true } | { ok: false; error: string }>
  'ssh:deploy': (params: DeployParamsDto) => Promise<{ ok: boolean; error?: string }>
  'ssh:setBotWebhook': (token: string) => Promise<{ ok: boolean; error?: string }>
  'ssh:setEngineEnv': (params: {
    geminiApiKey: string
  }) => Promise<{ ok: boolean; error?: string }>
  'chat:send': (text: string) => Promise<void>
  'chat:history': (opts: {
    before?: string
    limit?: number
  }) => Promise<{ messages: Message[]; hasMore: boolean }>
  /**
   * Open the WS connection to the multi-server. Renderer calls this once
   * the wizard reaches `done` (and an `hostedJwt` is available).
   */
  'chat:start': () => Promise<void>
  'app:getInfo': () => Promise<AppInfo>
  'updater:install-now': () => Promise<void>
  'updater:check-now': () => Promise<{ ok: true; version: string | null } | { ok: false; error: string }>
  // Push events (main -> renderer), delivered via window.api.on(channel, cb):
  //   'chat:event'              payload: ServerMessage from src/shared/chat-protocol
  //   'chat:connection'         payload: { status: 'connecting' | 'open' | 'reconnecting' | 'auth-failed' }
  //   'updater:available'       payload: { version: string }
  //   'updater:download-progress' payload: { percent: number; bytesPerSecond: number }
  //   'updater:downloaded'      payload: { version: string }
  //   'updater:error'           payload: { message: string }
}
