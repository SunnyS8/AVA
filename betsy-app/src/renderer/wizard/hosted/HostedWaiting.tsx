import type { CachedPreset } from '../../../main/persona-cache'

interface HostedWaitingProps {
  preset: CachedPreset
  deepLink: string | null
}

export function HostedWaiting({ preset, deepLink }: HostedWaitingProps): JSX.Element {
  const lines = preset.wizardLines as Record<string, string | string[]>
  const waiting = typeof lines.tg_login_waiting === 'string' ? lines.tg_login_waiting : ''

  return (
    <div>
      {waiting && <p className="text-blue-300 italic mb-6">«{waiting}»</p>}
      {deepLink && (
        <div className="bg-neutral-900 p-4 rounded text-sm text-neutral-400 mb-4">
          <div className="mb-2">Не открылось? Скопируй ссылку:</div>
          <div className="font-mono text-xs break-all">{deepLink}</div>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(deepLink)
            }}
            className="mt-2 text-xs underline"
          >
            Скопировать
          </button>
        </div>
      )}
      <div className="flex gap-2 items-center text-sm text-neutral-500">
        <div className="animate-pulse">●</div>
        Жду подключения…
      </div>
    </div>
  )
}
