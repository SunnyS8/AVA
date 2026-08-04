import { useState } from 'react'
import { api } from '../../ipc'
import type { CachedPreset } from '../../../main/persona-cache'

interface SshFormSubmit {
  host: string
  port: number
  user: string
  authKind: 'password' | 'key'
  saveCreds: boolean
}

interface SshFormProps {
  preset: CachedPreset
  onSubmitted: (params: SshFormSubmit) => void
}

export function SshForm({ preset, onSubmitted }: SshFormProps): JSX.Element {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('root')
  const [authKind, setAuthKind] = useState<'password' | 'key'>('password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [saveCreds, setSaveCreds] = useState(true)
  const lines = preset.wizardLines as Record<string, string | string[]>
  const prompt = typeof lines.ssh_prompt === 'string' ? lines.ssh_prompt : ''

  const submit = async (): Promise<void> => {
    setTesting(true)
    setError(null)
    const portNum = parseInt(port, 10)
    if (!host || !Number.isFinite(portNum)) {
      setError('Заполни host и port')
      setTesting(false)
      return
    }
    const creds = {
      host,
      port: portNum,
      username: user,
      password: authKind === 'password' ? password : undefined,
      privateKey: authKind === 'key' ? privateKey : undefined,
    }
    const r = await api.invoke('ssh:connect', creds)
    setTesting(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    await api.invoke('wizard:dispatch', {
      type: 'ssh-creds-submitted',
      host,
      port: portNum,
      user,
      authKind,
    })
    onSubmitted({ host, port: portNum, user, authKind, saveCreds })
  }

  return (
    <div>
      {prompt && <p className="text-amber-300 italic mb-6">«{prompt}»</p>}
      <div className="space-y-3 max-w-md">
        <div className="flex gap-2">
          <input
            className="flex-1 bg-neutral-900 p-2 rounded border border-neutral-800"
            placeholder="host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
          <input
            className="w-20 bg-neutral-900 p-2 rounded border border-neutral-800"
            placeholder="port"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
        <input
          className="w-full bg-neutral-900 p-2 rounded border border-neutral-800"
          placeholder="user"
          value={user}
          onChange={(e) => setUser(e.target.value)}
        />
        <div className="flex gap-3 text-sm">
          <label>
            <input
              type="radio"
              checked={authKind === 'password'}
              onChange={() => setAuthKind('password')}
            />{' '}
            Пароль
          </label>
          <label>
            <input
              type="radio"
              checked={authKind === 'key'}
              onChange={() => setAuthKind('key')}
            />{' '}
            Ключ
          </label>
        </div>
        {authKind === 'password' ? (
          <input
            type="password"
            className="w-full bg-neutral-900 p-2 rounded border border-neutral-800"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        ) : (
          <textarea
            className="w-full bg-neutral-900 p-2 rounded border border-neutral-800 font-mono text-xs h-32"
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----…"
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
          />
        )}
        <label className="text-sm text-neutral-400 block">
          <input
            type="checkbox"
            checked={saveCreds}
            onChange={(e) => setSaveCreds(e.target.checked)}
          />{' '}
          Запомнить для обновлений (зашифровано DPAPI)
        </label>
        {error && <div className="text-red-400 text-sm">{error}</div>}
        <button
          onClick={() => void submit()}
          disabled={testing || !host}
          className="px-6 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded"
        >
          {testing ? 'Проверяю…' : 'Проверить подключение'}
        </button>
      </div>
    </div>
  )
}
