import { useEffect, useState } from 'react'
import { api } from '../ipc'
import type { AppInfo } from '../../shared/ipc-contract'

export function EngineUpdateTab(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void api.invoke('app:getInfo').then(setInfo)
  }, [])

  if (!info) return <div className="text-neutral-400">Загрузка…</div>

  if (info.mode === 'hosted') {
    return (
      <div className="text-sm text-neutral-300">
        В hosted-режиме engine обновляется автоматически. Делать ничего не нужно.
      </div>
    )
  }

  if (info.mode !== 'selfhost') {
    return (
      <div className="text-sm text-neutral-300">
        Сначала пройди wizard, чтобы появилась возможность обновлять engine.
      </div>
    )
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-neutral-300">
        Обновление self-host engine выполняется по SSH. Команда: `docker compose pull && up -d`.
      </p>
      <p className="text-neutral-500 text-xs">
        UI для запуска обновления отсюда появится в следующей версии (нужна повторная авторизация
        по SSH). Сейчас обновить можно вручную: ssh на VPS, `cd /opt/betsy-multi && docker compose
        pull && docker compose up -d`.
      </p>
    </div>
  )
}
