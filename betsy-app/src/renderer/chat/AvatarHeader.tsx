import type { ConnectionStatus } from './chat-reducer'

interface Props {
  personaName: string
  avatarUrl: string | null
  status: ConnectionStatus
  onSettings?: () => void
}

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  open: '#10b981',
  'auth-failed': '#ef4444',
  connecting: '#fbbf24',
  reconnecting: '#fbbf24',
}

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  open: 'онлайн',
  'auth-failed': 'сессия истекла',
  connecting: 'подключаюсь…',
  reconnecting: 'переподключаюсь…',
}

export function AvatarHeader({
  personaName,
  avatarUrl,
  status,
  onSettings,
}: Props): JSX.Element {
  return (
    <header className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800 bg-neutral-950">
      {avatarUrl ? (
        <img
          src={`file://${avatarUrl}`}
          alt=""
          className="w-9 h-9 rounded-full object-cover"
        />
      ) : (
        <div className="w-9 h-9 rounded-full bg-neutral-700" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-neutral-200 truncate">{personaName}</div>
        <div
          className="text-xs flex items-center gap-1.5"
          style={{ color: STATUS_COLORS[status] }}
        >
          <span>●</span>
          <span>{STATUS_LABELS[status]}</span>
        </div>
      </div>
      {onSettings && (
        <button
          type="button"
          onClick={onSettings}
          aria-label="Настройки"
          title="Настройки"
          className="text-neutral-400 hover:text-neutral-100 transition-colors p-2 -mr-1"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
      )}
    </header>
  )
}
