// Shared contract between the Betsy multi engine and the Electron self-host
// wizard. Generates the .env file that the wizard SCPs to
// /opt/betsy-multi/.env on the user's VPS.
//
// IMPORTANT: every key emitted here must be a key the engine actually reads
// (see src/multi/env.ts at the repo root). The wizard-env-smoke test in
// tests/multi/server/wizard-env-smoke.test.ts feeds the output of
// generateEnv() through the engine's envSchema to enforce this contract at
// the test level. If you change this file, run:
//
//   npx vitest run tests/multi/server/wizard-env-smoke.test.ts
//
// The test imports this file by relative path because betsy-app has its own
// rootDir/tsconfig isolation and we can't cleanly share a single module
// between the two compilation trees. The relative-import lock is intentional
// and brittle on purpose — moving this file should be loud.
import { randomBytes } from 'node:crypto'

export interface EnvParams {
  presetId: string
  publicUrl: string
  port?: number
  botToken?: string
  geminiApiKey?: string
  engineVersion?: string
}

export interface GeneratedEnv {
  env: Record<string, string>
  asEnvFile: string
  dbPassword: string
  jwtSecret: string
}

export function generateEnv(params: EnvParams): GeneratedEnv {
  const dbPassword = randomBytes(24).toString('hex')
  const jwtSecret = randomBytes(48).toString('hex')
  const port = String(params.port ?? 3777)
  const env: Record<string, string> = {
    // Postgres + secrets
    BC_DB_PASSWORD: dbPassword,
    BC_DATABASE_URL: `postgres://betsy:${dbPassword}@postgres:5432/betsy`,
    BC_JWT_SECRET: jwtSecret,

    // LLM — AI Studio key (Vertex needs a service account JSON, not exposed
    // through the wizard for P1).
    GEMINI_API_KEY: params.geminiApiKey ?? '',

    // Telegram (writable via setBotWebhook IPC after install)
    BC_TELEGRAM_BOT_TOKEN: params.botToken ?? '',

    // HTTP / webhooks. We pin BC_HEALTHZ_PORT to the same port as the
    // public/API port so the wizard's healthz probe and the docker-compose
    // port mapping both line up (the engine accepts any healthz port; see
    // src/multi/server.ts -> startHealthzServer).
    BC_PORT: port,
    BC_HTTP_PORT: port,
    BC_HEALTHZ_PORT: port,
    BC_WEBHOOK_BASE_URL: params.publicUrl,

    // Image tag for the docker-compose template substitution
    BC_ENGINE_VERSION: params.engineVersion ?? 'latest',
  }
  const asEnvFile =
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  return { env, asEnvFile, dbPassword, jwtSecret }
}
