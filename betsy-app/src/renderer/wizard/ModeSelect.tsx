import type { CachedPreset } from '../../main/persona-cache'

interface ModeSelectProps {
  preset: CachedPreset
  onSelect: (mode: 'hosted' | 'selfhost') => void
}

export function ModeSelect({ preset, onSelect }: ModeSelectProps): JSX.Element {
  const lines = preset.wizardLines as Record<string, string | string[]>
  const checklist = Array.isArray(lines.mode_selfhost_checklist)
    ? lines.mode_selfhost_checklist
    : []
  const hostedPitch = typeof lines.mode_hosted_pitch === 'string' ? lines.mode_hosted_pitch : 'подписка'
  const selfhostHint =
    typeof lines.mode_selfhost_hint === 'string' ? lines.mode_selfhost_hint : ''

  return (
    <div>
      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => onSelect('hosted')}
          className="p-6 border border-neutral-800 rounded-xl hover:border-emerald-500 text-left transition-colors"
        >
          <div className="text-xl mb-2">Хостим у нас</div>
          <div className="text-sm text-neutral-400">{hostedPitch}</div>
          <ul className="mt-4 text-sm space-y-1 text-neutral-300">
            <li>+ ничего не нужно</li>
            <li>+ работает за 2 минуты</li>
            <li>+ обновления автоматические</li>
          </ul>
        </button>
        <button
          onClick={() => onSelect('selfhost')}
          className="p-6 border border-neutral-800 rounded-xl hover:border-amber-500 text-left transition-colors"
        >
          <div className="text-xl mb-2">На моём VPS</div>
          <div className="text-sm text-neutral-400">полная самостоятельность</div>
          <div className="mt-4 text-sm">
            <div className="text-neutral-400 mb-1">понадобится:</div>
            <ul className="space-y-1 text-neutral-300">
              {checklist.map((item) => (
                <li key={item}>- {item}</li>
              ))}
            </ul>
          </div>
        </button>
      </div>
      {selfhostHint && (
        <p className="text-emerald-300 italic mt-6 text-sm">«{selfhostHint}»</p>
      )}
    </div>
  )
}
