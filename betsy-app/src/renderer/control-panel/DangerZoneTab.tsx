import { useState } from 'react'
import { api } from '../ipc'

export function DangerZoneTab(): JSX.Element {
  const [confirming, setConfirming] = useState(false)

  const resetWizard = async (): Promise<void> => {
    await api.invoke('wizard:dispatch', { type: 'reset' })
    setConfirming(false)
  }

  return (
    <div className="space-y-4">
      <div className="border border-red-900/60 rounded p-4">
        <h3 className="text-red-400 mb-2">Сбросить wizard</h3>
        <p className="text-sm text-neutral-400 mb-3">
          Удалит локальное состояние и снова покажет первый экран (выбор персонажа). На VPS / в
          hosted ничего не меняется.
        </p>
        {confirming ? (
          <div className="flex gap-2">
            <button
              onClick={() => void resetWizard()}
              className="px-4 py-2 bg-red-700 hover:bg-red-600 rounded text-sm"
            >
              Подтвердить сброс
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
            >
              Отмена
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="px-4 py-2 bg-red-700/60 hover:bg-red-600 rounded text-sm"
          >
            Сбросить
          </button>
        )}
      </div>
      <div className="border border-red-900/60 rounded p-4 opacity-60">
        <h3 className="text-red-400 mb-2">Снести Бетси с VPS</h3>
        <p className="text-sm text-neutral-400">
          `docker compose down && rm -rf /opt/betsy-multi`. Появится после повторной SSH-авторизации
          в control panel.
        </p>
      </div>
    </div>
  )
}
