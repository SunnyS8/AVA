import { useEffect, useState } from 'react'
import { api } from '../../ipc'
import type { CachedPreset } from '../../../main/persona-cache'
import type { WizardState } from '../../../main/wizard-engine'

interface InstallProgressProps {
  preset: CachedPreset
  state: WizardState
}

interface ProgressEvent {
  pct: number
  log?: string
}

export function InstallProgress({ preset, state }: InstallProgressProps): JSX.Element {
  const lines = preset.wizardLines as Record<string, string | string[]>
  const intro = typeof lines.install_progress === 'string' ? lines.install_progress : ''
  const [pct, setPct] = useState(state.installProgress)
  const [logLines, setLogLines] = useState<string[]>(state.installLog)
  const [stdoutLines, setStdoutLines] = useState<string[]>([])

  useEffect(() => {
    const offProg = api.on('install:progress', (data) => {
      const e = data as ProgressEvent
      if (typeof e.pct === 'number') setPct(e.pct)
      if (typeof e.log === 'string') setLogLines((prev) => [...prev, e.log!])
    })
    const offLog = api.on('install:log', (data) => {
      const s = String(data)
      setStdoutLines((prev) => [...prev.slice(-200), s])
    })
    return () => {
      offProg()
      offLog()
    }
  }, [])

  return (
    <div>
      {intro && <p className="text-amber-300 italic mb-6">«{intro}»</p>}
      <div className="mb-4">
        <div className="w-full bg-neutral-900 rounded h-3 overflow-hidden">
          <div
            className="h-full bg-amber-500 transition-all"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
        <div className="text-xs text-neutral-500 mt-1">{pct}%</div>
      </div>
      <div className="text-sm text-neutral-300 mb-3 space-y-1">
        {logLines.map((line, i) => (
          <div key={i}>- {line}</div>
        ))}
      </div>
      {stdoutLines.length > 0 && (
        <details className="text-xs text-neutral-500">
          <summary className="cursor-pointer">Подробный лог</summary>
          <pre className="mt-2 bg-neutral-900 p-2 rounded max-h-64 overflow-auto whitespace-pre-wrap">
            {stdoutLines.join('')}
          </pre>
        </details>
      )}
      {state.installError && (
        <div className="text-red-400 text-sm mt-3">Ошибка: {state.installError}</div>
      )}
    </div>
  )
}
