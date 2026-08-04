import { useEffect, useState } from 'react'
import { api } from '../ipc'
import type { AppInfo } from '../../shared/ipc-contract'

export function StatusTab(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void api.invoke('app:getInfo').then(setInfo)
  }, [])

  if (!info) return <div className="text-neutral-400">Загрузка…</div>

  const modeLabel =
    info.mode === 'hosted'
      ? 'Хостинг у нас'
      : info.mode === 'selfhost'
        ? 'На моём VPS'
        : 'Не настроено'

  return (
    <dl className="space-y-3 text-sm">
      <div>
        <dt className="text-neutral-400">Режим</dt>
        <dd className="text-base">{modeLabel}</dd>
      </div>
      <div>
        <dt className="text-neutral-400">Engine URL</dt>
        <dd className="text-base font-mono break-all">{info.engineUrl ?? '—'}</dd>
      </div>
      <div>
        <dt className="text-neutral-400">Версия приложения</dt>
        <dd className="text-base">{info.version}</dd>
      </div>
    </dl>
  )
}
