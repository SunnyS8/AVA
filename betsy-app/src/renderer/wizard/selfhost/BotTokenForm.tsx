import { useState } from 'react'
import { api } from '../../ipc'
import type { CachedPreset } from '../../../main/persona-cache'

interface BotTokenFormProps {
  preset: CachedPreset
}

export function BotTokenForm({ preset }: BotTokenFormProps): JSX.Element {
  const lines = preset.wizardLines as Record<string, string | string[]>
  const prompt = typeof lines.bot_token_prompt === 'string' ? lines.bot_token_prompt : ''
  const [token, setToken] = useState('')
  const [geminiKey, setGeminiKey] = useState('')
  const [showGemini, setShowGemini] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setWarning(null)
    try {
      await api.invoke('wizard:dispatch', { type: 'bot-token-submitted', token })

      // Push GEMINI_API_KEY first if supplied — the engine restart triggered
      // by setBotWebhook will then pick up both new values in one go. If the
      // user skipped the field, surface a non-fatal warning instead of
      // failing: the engine will refuse to boot and the user has to SSH in,
      // but we want to ship the bot token regardless so the wizard can
      // finish the linking flow.
      if (geminiKey.trim()) {
        const ge = await api.invoke('ssh:setEngineEnv', {
          geminiApiKey: geminiKey.trim(),
        })
        if (!ge.ok) {
          setError(ge.error ?? 'failed to write GEMINI_API_KEY')
          return
        }
      } else {
        setWarning(
          'Бетси не сможет отвечать без Gemini API key. Добавь его позже через SSH в /opt/betsy-multi/.env (GEMINI_API_KEY=...).',
        )
      }

      const r = await api.invoke('ssh:setBotWebhook', token)
      if (!r.ok) {
        setError(r.error ?? 'unknown')
        return
      }
      // Defensive dispatch — main-process handler also dispatches
      // bot-webhook-ok on success, but routing the event through the
      // renderer keeps this form's "success" path testable in isolation
      // and survives a refactor that removes the main-side dispatch.
      // Reducer is idempotent (already-done step is a no-op).
      await api.invoke('wizard:dispatch', { type: 'bot-webhook-ok' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {prompt && <p className="text-amber-300 italic mb-6">«{prompt}»</p>}
      <div className="space-y-3 max-w-md">
        <input
          className="w-full bg-neutral-900 p-2 rounded border border-neutral-800 font-mono"
          placeholder="123456:ABC-DEF... (Telegram bot token)"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="relative">
          <input
            className="w-full bg-neutral-900 p-2 pr-12 rounded border border-neutral-800 font-mono"
            type={showGemini ? 'text' : 'password'}
            placeholder="Gemini API key (опционально)"
            value={geminiKey}
            onChange={(e) => setGeminiKey(e.target.value)}
          />
          <button
            type="button"
            onClick={() => setShowGemini((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-neutral-400 hover:text-neutral-200"
            aria-label={showGemini ? 'Скрыть Gemini key' : 'Показать Gemini key'}
          >
            {showGemini ? 'скрыть' : 'показать'}
          </button>
        </div>
        {error && <div className="text-red-400 text-sm">{error}</div>}
        {warning && <div className="text-amber-400 text-sm">{warning}</div>}
        <button
          onClick={() => void submit()}
          disabled={busy || !token}
          className="px-6 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded"
        >
          {busy ? 'Настраиваю…' : 'Подключить бота'}
        </button>
        <p className="text-xs text-neutral-500">
          Создай бота в @BotFather и вставь токен сюда. Gemini API key получи в
          Google AI Studio — без него Бетси не сможет отвечать.
        </p>
      </div>
    </div>
  )
}
