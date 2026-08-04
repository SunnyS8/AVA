import { SshBootstrap } from './ssh-bootstrap'

export interface EngineUpdateManifest {
  latest: string
  releasedAt?: string
  minShellVersion?: string
}

export async function checkEngineUpdate(apiBase: string): Promise<EngineUpdateManifest> {
  const r = await fetch(`${apiBase}/updates/engine/latest.json`)
  if (!r.ok) throw new Error(`update check failed: ${r.status}`)
  return (await r.json()) as EngineUpdateManifest
}

export async function applyEngineUpdate(bootstrap: SshBootstrap): Promise<void> {
  await bootstrap.updateEngine()
}
