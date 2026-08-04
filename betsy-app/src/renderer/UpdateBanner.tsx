import { useEffect, useState } from 'react'
import { api } from './ipc'

interface UpdateAvailableEvent {
  version: string
}
interface UpdateProgressEvent {
  percent: number
  bytesPerSecond: number
}
interface UpdateErrorEvent {
  message: string
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string }

/**
 * Sticky banner across the top of the window. Stays out of the way until
 * electron-updater finds a new version, then surfaces a one-click restart.
 *
 * Behavior:
 *   - 'updater:available'           → "Обновление X.Y.Z скачивается…" (no button)
 *   - 'updater:download-progress'   → shows percent in same banner
 *   - 'updater:downloaded'          → "Готово к перезапуску" + кнопка
 *   - 'updater:error'               → dismissable error toast
 *
 * Click "Обновить" → IPC 'updater:install-now' → app quits + reinstalls + reopens.
 */
export function UpdateBanner(): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const offAvail = api.on('updater:available', (data: unknown) => {
      const d = data as UpdateAvailableEvent
      setPhase({ kind: 'downloading', version: d.version, percent: 0 })
      setDismissed(false)
    })
    const offProg = api.on('updater:download-progress', (data: unknown) => {
      const d = data as UpdateProgressEvent
      setPhase((p) =>
        p.kind === 'downloading'
          ? { ...p, percent: d.percent }
          : p,
      )
    })
    const offDone = api.on('updater:downloaded', (data: unknown) => {
      const d = data as UpdateAvailableEvent
      setPhase({ kind: 'ready', version: d.version })
      setDismissed(false)
    })
    const offErr = api.on('updater:error', (data: unknown) => {
      const d = data as UpdateErrorEvent
      setPhase({ kind: 'error', message: d.message })
    })
    return () => {
      offAvail()
      offProg()
      offDone()
      offErr()
    }
  }, [])

  if (phase.kind === 'idle' || dismissed) return null

  if (phase.kind === 'downloading') {
    return (
      <div className="bg-blue-950 border-b border-blue-800 text-blue-100 text-sm px-4 py-2 flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
        <span>Обновление {phase.version} скачивается…</span>
        {phase.percent > 0 && (
          <span className="text-blue-300 tabular-nums">{phase.percent}%</span>
        )}
      </div>
    )
  }

  if (phase.kind === 'ready') {
    return (
      <div className="bg-emerald-950 border-b border-emerald-800 text-emerald-100 text-sm px-4 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span>●</span>
          <span>Готово обновление до {phase.version}.</span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="px-2.5 py-1 text-emerald-300 hover:text-emerald-100"
          >
            Позже
          </button>
          <button
            type="button"
            onClick={() => void api.invoke('updater:install-now')}
            className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 rounded text-white font-medium"
          >
            Перезапустить
          </button>
        </div>
      </div>
    )
  }

  // error
  return (
    <div className="bg-red-950 border-b border-red-800 text-red-100 text-sm px-4 py-2 flex items-center justify-between gap-3">
      <span>Не получилось проверить обновление: {phase.message}</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="text-red-300 hover:text-red-100 px-2"
      >
        ×
      </button>
    </div>
  )
}
