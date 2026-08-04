import { useState } from 'react'
import { StatusTab } from './StatusTab'
import { PersonaTab } from './PersonaTab'
import { EngineUpdateTab } from './EngineUpdateTab'
import { DangerZoneTab } from './DangerZoneTab'

type Tab = 'status' | 'persona' | 'engine' | 'danger'

interface ControlPanelProps {
  onClose: () => void
}

export function ControlPanel({ onClose }: ControlPanelProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('status')

  const tabs: { id: Tab; label: string }[] = [
    { id: 'status', label: 'Статус' },
    { id: 'persona', label: 'Персонаж' },
    { id: 'engine', label: 'Обновления' },
    { id: 'danger', label: 'Опасная зона' },
  ]

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-neutral-950 border border-neutral-800 rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <header className="flex items-center justify-between p-4 border-b border-neutral-800">
          <h2 className="text-lg">Настройки</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-white">
            ×
          </button>
        </header>
        <div className="flex border-b border-neutral-800 text-sm">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 ${
                tab === t.id
                  ? 'border-b-2 border-emerald-500 text-white'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="p-4 overflow-auto flex-1">
          {tab === 'status' && <StatusTab />}
          {tab === 'persona' && <PersonaTab />}
          {tab === 'engine' && <EngineUpdateTab />}
          {tab === 'danger' && <DangerZoneTab />}
        </div>
      </div>
    </div>
  )
}
