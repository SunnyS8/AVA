import { useLayoutEffect, useRef, type UIEvent } from 'react'
import type { Message } from '../../shared/chat-protocol'

interface Props {
  messages: Message[]
  streaming: Record<string, string>
  onScrollTop?: () => void
}

function channelTag(channel: Message['channel']): string {
  if (channel === 'telegram') return 'TG'
  if (channel === 'max') return 'MAX'
  return ''
}

export function MessageList({ messages, streaming, onScrollTop }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // First time history actually lands we force-scroll to the bottom (latest
  // message). After that, follow the "stick to bottom only if user is already
  // near the bottom" rule so manual scrolling up to read older context isn't
  // yanked back down by new arrivals.
  const didInitialScrollRef = useRef(false)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (!didInitialScrollRef.current && messages.length > 0) {
      el.scrollTop = el.scrollHeight
      didInitialScrollRef.current = true
      return
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  function onScroll(e: UIEvent<HTMLDivElement>): void {
    // Suppress the lazy-load-older trigger until we've performed the initial
    // scroll-to-bottom — otherwise the synthetic scroll event during paint
    // (when scrollTop briefly is 0) would fire onScrollTop spuriously.
    if (
      didInitialScrollRef.current &&
      e.currentTarget.scrollTop < 50 &&
      onScrollTop
    ) {
      onScrollTop()
    }
  }

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5"
    >
      {messages.map((m) => {
        const liveStream = streaming[m.id]
        const text = liveStream ?? m.text
        const isStreaming = liveStream !== undefined
        const isUser = m.role === 'user'
        const tag = channelTag(m.channel)
        return (
          <div key={m.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[70%] px-3.5 py-2.5 rounded-2xl text-[13.5px] whitespace-pre-wrap break-words ${
                isUser
                  ? 'bg-blue-600 text-white rounded-br-md'
                  : 'bg-neutral-800 text-neutral-100 rounded-bl-md'
              }`}
            >
              {text}
              {isStreaming && (
                <span className="inline-block w-2 h-3 bg-emerald-400 ml-1 animate-pulse align-baseline" />
              )}
              <div
                className={`text-[10.5px] mt-1 ${isUser ? 'text-blue-100/80' : 'text-neutral-500'}`}
              >
                {new Date(m.createdAt).toLocaleTimeString('ru-RU', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {tag && <span className="ml-1.5">· {tag}</span>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
