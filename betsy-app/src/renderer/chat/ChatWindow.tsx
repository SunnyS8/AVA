import { AvatarHeader } from './AvatarHeader'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { ReAuthBanner } from './ReAuthBanner'
import { useChat } from './useChat'

interface Props {
  personaName: string
  avatarUrl: string | null
  onReauth: () => void
  onSettings?: () => void
}

export function ChatWindow({ personaName, avatarUrl, onReauth, onSettings }: Props): JSX.Element {
  const { state, send, loadOlder } = useChat()

  if (state.status === 'auth-failed') {
    return <ReAuthBanner onReauth={onReauth} />
  }

  return (
    <div className="h-screen flex flex-col bg-neutral-950">
      <AvatarHeader
        personaName={personaName}
        avatarUrl={avatarUrl}
        status={state.status}
        onSettings={onSettings}
      />
      <MessageList
        messages={state.messages}
        streaming={state.streaming}
        onScrollTop={loadOlder}
      />
      <Composer onSend={(t) => void send(t)} disabled={state.status !== 'open'} />
    </div>
  )
}
