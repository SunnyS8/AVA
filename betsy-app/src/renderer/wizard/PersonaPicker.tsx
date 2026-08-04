import type { CachedPreset } from '../../main/persona-cache'

interface PersonaPickerProps {
  presets: CachedPreset[]
  avatars: Record<string, string | null>
  onSelect: (presetId: string) => void
}

export function PersonaPicker({ presets, avatars, onSelect }: PersonaPickerProps): JSX.Element {
  return (
    <div>
      <h1 className="text-2xl mb-2">Привет, я Бетси.</h1>
      <p className="text-neutral-400 mb-6">Выбери, какой ассистент тебе ближе.</p>
      {presets.length === 0 && (
        <p className="text-neutral-500">Загружаю каталог персонажей…</p>
      )}
      <div className="grid grid-cols-2 gap-4">
        {presets.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className="p-5 border border-neutral-800 rounded-xl hover:border-neutral-600 text-left transition-colors"
          >
            {avatars[p.id] && (
              <img
                src={`file://${avatars[p.id]}`}
                alt=""
                className="w-20 h-20 rounded-full mb-3 object-cover bg-neutral-800"
              />
            )}
            <div className="text-lg font-medium">{p.name}</div>
            <div className="text-sm text-neutral-400 mt-1">{p.biography}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
