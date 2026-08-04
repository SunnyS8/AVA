import { useState, type KeyboardEvent } from 'react'

interface Props {
  onSend: (text: string) => void
  disabled: boolean
}

export function Composer({ onSend, disabled }: Props): JSX.Element {
  const [text, setText] = useState('')

  function submit(): void {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 p-3 flex items-end gap-2">
      <textarea
        className="flex-1 bg-neutral-900 text-neutral-100 text-sm rounded-2xl px-3.5 py-2 resize-none max-h-32 outline-none focus:ring-1 focus:ring-blue-600 disabled:opacity-60"
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder={disabled ? 'Подключаюсь…' : 'Напиши сообщение…'}
        disabled={disabled}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!text.trim() || disabled}
        className="w-9 h-9 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white flex items-center justify-center"
        aria-label="Отправить"
      >
        ▶
      </button>
    </div>
  )
}
