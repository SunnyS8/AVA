import { useEffect, useState, useCallback, useRef } from 'react'
import { api } from './ipc'
import { PersonaPicker } from './wizard/PersonaPicker'
import { ModeSelect } from './wizard/ModeSelect'
import { HostedLogin } from './wizard/hosted/HostedLogin'
import { HostedWaiting } from './wizard/hosted/HostedWaiting'
import { SshForm } from './wizard/selfhost/SshForm'
import { InstallProgress } from './wizard/selfhost/InstallProgress'
import { BotTokenForm } from './wizard/selfhost/BotTokenForm'
import { ChatWindow } from './chat/ChatWindow'
import { ControlPanel } from './control-panel/ControlPanel'
import { UpdateBanner } from './UpdateBanner'
import { WizardShell } from './wizard/WizardShell'
import type { WizardState } from '../main/wizard-engine'
import type { CachedPreset } from '../main/persona-cache'

function getHeaderLine(state: WizardState, preset: CachedPreset | undefined): string | null {
  if (!preset) return null
  const lines = preset.wizardLines as Record<string, string | string[]>
  const pick = (k: string): string | null => {
    const v = lines[k]
    return typeof v === 'string' ? v : null
  }
  switch (state.step) {
    case 'mode-select':
      return pick('mode_intro')
    case 'hosted-login':
      return pick('tg_login_intro')
    case 'hosted-waiting':
      return pick('tg_login_waiting')
    case 'selfhost-ssh-form':
      return pick('ssh_prompt')
    case 'selfhost-install':
      return pick('install_progress')
    case 'selfhost-bot-token':
      return pick('bot_token_prompt')
    case 'done':
      return pick('wizard_complete')
    default:
      return null
  }
}

interface DeployContext {
  host: string
  port: number
  publicUrl: string
}

export function App(): JSX.Element {
  const [state, setState] = useState<WizardState | null>(null)
  const [presets, setPresets] = useState<CachedPreset[]>([])
  const [avatars, setAvatars] = useState<Record<string, string | null>>({})
  const [showSettings, setShowSettings] = useState(false)
  const deployCtx = useRef<DeployContext | null>(null)

  const loadState = useCallback(async () => {
    const s = await api.invoke('wizard:getState')
    setState(s)
  }, [])

  useEffect(() => {
    void (async () => {
      const list = await api.invoke('persona:list')
      setPresets(list)
      const av: Record<string, string | null> = {}
      for (const p of list) {
        av[p.id] = await api.invoke('persona:avatarPath', p.id)
      }
      setAvatars(av)
      await loadState()
    })()
  }, [loadState])

  useEffect(() => {
    const off = api.on('wizard:state-changed', (data) => {
      setState(data as WizardState)
    })
    return off
  }, [])

  if (!state) {
    return <div className="p-6 text-neutral-400">Загрузка…</div>
  }

  const preset = presets.find((p) => p.id === state.selectedPresetId)
  const headerLine = getHeaderLine(state, preset)

  const dispatch = async (
    event: Parameters<typeof api.invoke<'wizard:dispatch'>>[1],
  ): Promise<void> => {
    const next = await api.invoke('wizard:dispatch', event)
    setState(next)
  }

  // Once the wizard reaches `done` we leave the WizardShell entirely and
  // hand over the whole window to the chat UI. Settings live as an icon in
  // the chat header (no more bottom-corner overlay that clashed with Send).
  if (state.step === 'done') {
    const handleReauth = async (): Promise<void> => {
      await dispatch({ type: 'reset' })
    }
    return (
      <div className="h-screen flex flex-col">
        <UpdateBanner />
        <div className="flex-1 min-h-0">
          <ChatWindow
            personaName={preset?.name ?? 'Бетси'}
            avatarUrl={preset ? avatars[preset.id] ?? null : null}
            onReauth={() => {
              void handleReauth()
            }}
            onSettings={() => setShowSettings(true)}
          />
        </div>
        {showSettings && <ControlPanel onClose={() => setShowSettings(false)} />}
      </div>
    )
  }

  let body: JSX.Element

  if (state.step === 'persona-picker') {
    body = (
      <PersonaPicker
        presets={presets}
        avatars={avatars}
        onSelect={(presetId) => {
          void dispatch({ type: 'persona-selected', presetId })
        }}
      />
    )
  } else if (state.step === 'mode-select' && preset) {
    body = (
      <ModeSelect
        preset={preset}
        onSelect={(mode) => {
          void dispatch({ type: 'mode-selected', mode })
        }}
      />
    )
  } else if (state.step === 'hosted-login' && preset) {
    body = <HostedLogin preset={preset} pollError={state.hostedError} />
  } else if (state.step === 'hosted-waiting' && preset) {
    body = <HostedWaiting preset={preset} deepLink={state.hostedDeepLink} />
  } else if (state.step === 'selfhost-ssh-form' && preset) {
    body = (
      <SshForm
        preset={preset}
        onSubmitted={(params) => {
          const publicUrl = `http://${params.host}:3777`
          deployCtx.current = { host: params.host, port: params.port, publicUrl }
          void api.invoke('ssh:deploy', {
            presetId: preset.id,
            publicUrl,
            saveCreds: params.saveCreds,
            host: params.host,
            user: params.user,
            port: params.port,
          })
        }}
      />
    )
  } else if (state.step === 'selfhost-install' && preset) {
    body = <InstallProgress preset={preset} state={state} />
  } else if (state.step === 'selfhost-bot-token' && preset) {
    body = <BotTokenForm preset={preset} />
  } else {
    body = (
      <div>
        <h2 className="text-lg mb-2">Step: {state.step}</h2>
        <p className="text-neutral-500 text-sm">Нет данных персонажа для этого шага.</p>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col">
      <UpdateBanner />
      <div className="flex-1 min-h-0 overflow-auto">
        <WizardShell
          state={state}
          avatarPath={preset ? avatars[preset.id] ?? null : null}
          headerLine={headerLine}
        >
          {body}
        </WizardShell>
      </div>
      {showSettings && <ControlPanel onClose={() => setShowSettings(false)} />}
    </div>
  )
}
