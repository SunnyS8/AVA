import { useEffect, useState } from 'react'
import { api } from '../ipc'
import type { CachedPreset } from '../../main/persona-cache'
import type { WizardState } from '../../main/wizard-engine'

export function PersonaTab(): JSX.Element {
  const [presets, setPresets] = useState<CachedPreset[]>([])
  const [state, setState] = useState<WizardState | null>(null)

  useEffect(() => {
    void api.invoke('persona:list').then(setPresets)
    void api.invoke('wizard:getState').then(setState)
  }, [])

  const current = presets.find((p) => p.id === state?.selectedPresetId)

  return (
    <div className="space-y-4">
      <div>
        <div className="text-neutral-400 text-sm">Текущий персонаж</div>
        <div className="text-base">{current?.name ?? '—'}</div>
        {current?.biography && (
          <div className="text-sm text-neutral-400 mt-1">{current.biography}</div>
        )}
      </div>
      <p className="text-xs text-neutral-500">
        Смена персонажа без перезапуска wizard'а появится в следующей версии.
      </p>
    </div>
  )
}
