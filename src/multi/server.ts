import { loadEnv } from './env.js'
import { log } from './observability/logger.js'
import { buildPool, closePool } from './db/pool.js'
import { runMigrations } from './db/migrate.js'
import { buildS3Storage, getS3Storage } from './storage/s3.js'
import { buildGemini, getGemini } from './gemini/client.js'
import { startHealthzServer } from './http/healthz.js'
import { TelegramAdapter } from './channels/telegram.js'
import { MaxAdapter } from './channels/max.js'
import type { ChannelAdapter, ChannelName } from './channels/base.js'
import { BotRouter } from './bot-router/router.js'
import { WorkspaceRepo } from './workspaces/repo.js'
import { PersonaRepo } from './personas/repo.js'
import { FactsRepo } from './memory/facts-repo.js'
import { ConversationRepo } from './memory/conversation-repo.js'
import { RemindersRepo } from './reminders/repo.js'
import { LinkCodesRepo } from './linking/repo.js'
import { LinkingService } from './linking/service.js'
import { runBetsy, runBetsyStream } from './agents/runner.js'
import { runWithGeminiTools } from './agents/gemini-runner.js'
import { startRemindersWorker } from './jobs/reminders-worker.js'
// WAVE3C-MERGE: oauth relay callback + oauth/mcp repos for integration tools.
import { OAuthRepo } from './oauth/repo.js'
import { McpServersRepo } from './agents/mcp/repo.js'
import { McpRegistry } from './agents/mcp/registry.js'
import { OAuthResolver } from './agents/mcp/oauth-resolver.js'
import { createRelayCallbackHandler } from './oauth/relay-callback.js'
// FIX1: post-stream critic wiring (previously never instantiated).
import { Critic } from './critic/critic.js'
// FIX1.5: Wave 1C/2A wiring gaps — SkillManager and Learner CandidatesRepo
// were imported in runner.ts but never instantiated in server.ts, so
// run_skill/list_skills and list/approve/reject_skill_candidate tools
// silently disappeared from the root agent.
import { SkillsRepo } from './skills/repo.js'
import { SkillManager } from './skills/manager.js'
import { CandidatesRepo as LearnerCandidatesRepo } from './learner/candidates-repo.js'
// FIX2: wire FeedbackService into telegram channel so inline 👍/👎 callbacks
// are actually recorded. Wave 2C built the infrastructure but server.ts never
// instantiated the service, so channel.setFeedbackService(undefined) was a silent no-op.
import { FeedbackRepo } from './feedback/repo.js'
import { ProposalsRepo as CoachProposalsRepo } from './coach/proposals-repo.js'
import { FeedbackService } from './feedback/service.js'
// Fix4: pg-boss cron wiring for Learner / Skills / Coach nightly runners.
import * as PgBossModule from 'pg-boss'
const PgBoss: any = (PgBossModule as any).default ?? (PgBossModule as any).PgBoss ?? PgBossModule
import { Learner } from './learner/learner.js'
import { createGeminiPatternLLM } from './learner/pattern-detector.js'
import { createGeminiSkillGeneratorLLM } from './learner/skill-generator.js'
import { Coach } from './coach/coach.js'
import { createGeminiCoachLLM } from './coach/analyzer.js'
import { registerCronWiring, createAdminCronHandler, type CronRunners } from './cron-wiring.js'
// P1.A — public preset catalog endpoint (no auth) consumed by Windows-app wizard.
import { createCatalogPersonasHandler } from './personas/catalog-handler.js'
// P1.A — Telegram deep-link login flow used by Windows-app wizard for hosted mode.
import { TgLinkRepo } from './auth/tg-link-repo.js'
import { TgLinkService } from './auth/tg-link-service.js'
import {
  createTgLinkStartHandler,
  createTgLinkPollHandler,
} from './auth/tg-link-http.js'
import { TgLinkSweepRunner } from './auth/tg-link-sweep.js'
// P1.5 — desktop chat channel.
import { createHistoryHandler } from './chat/history-handler.js'
import { verifyJwt } from './auth/jwt.js'
import { DesktopAdapter } from './channels/desktop.js'
import { OutboundDispatcher } from './channels/outbound-dispatcher.js'

export async function startMultiServer(): Promise<void> {
  let env
  try {
    env = loadEnv()
  } catch (e) {
    console.error('[betsy-multi] env validation failed:', (e as Error).message)
    process.exit(1)
  }

  const logger = log()
  logger.info('betsy-multi starting', {
    logLevel: env.BC_LOG_LEVEL,
    httpPort: env.BC_HTTP_PORT,
    healthzPort: env.BC_HEALTHZ_PORT,
  })

  // Postgres
  const pool = buildPool(env.BC_DATABASE_URL)
  const applied = await runMigrations(pool)
  logger.info('migrations applied', { count: applied.length, files: applied })

  // S3 (only if credentials present)
  if (env.BC_S3_ACCESS_KEY && env.BC_S3_SECRET_KEY) {
    buildS3Storage({
      endpoint: env.BC_S3_ENDPOINT,
      region: env.BC_S3_REGION,
      bucket: env.BC_S3_BUCKET,
      accessKeyId: env.BC_S3_ACCESS_KEY,
      secretAccessKey: env.BC_S3_SECRET_KEY,
    })
    logger.info('s3 storage initialized', { bucket: env.BC_S3_BUCKET })
  } else {
    logger.warn('s3 credentials missing, storage disabled')
  }

  // Gemini client — Vertex AI mode (no regional restrictions) or AI Studio (legacy)
  if (env.BC_GEMINI_VERTEX === '1') {
    buildGemini({
      vertexai: true,
      project: env.BC_GCP_PROJECT,
      location: env.BC_GCP_LOCATION,
    })
    logger.info('gemini client initialized (vertex)', {
      project: env.BC_GCP_PROJECT,
      location: env.BC_GCP_LOCATION,
      models: [
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.5-flash-image-preview',
        'gemini-2.5-flash-preview-tts',
      ],
    })
  } else {
    buildGemini({ apiKey: env.GEMINI_API_KEY! })
    logger.info('gemini client initialized (ai studio)', {
      models: [
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.5-flash-image-preview',
        'gemini-2.5-flash-preview-tts',
      ],
    })
  }

  // Repos
  const wsRepo = new WorkspaceRepo(pool)
  const personaRepo = new PersonaRepo(pool)
  const factsRepo = new FactsRepo(pool, getGemini())
  const convRepo = new ConversationRepo(pool, getGemini())
  const remindersRepo = new RemindersRepo(pool)
  const linkCodesRepo = new LinkCodesRepo(pool)
  const linkingSvc = new LinkingService(linkCodesRepo, {
    findById: async (id: string) => {
      const w = await wsRepo.findById(id)
      return w ? { id: w.id, ownerTgId: w.ownerTgId, ownerMaxId: w.ownerMaxId } : null
    },
    updateOwnerTg: (id: string, tgId: number) => wsRepo.updateOwnerTg(id, tgId),
    updateOwnerMax: (id: string, maxId: number) => wsRepo.updateOwnerMax(id, maxId),
  })

  // Channels
  const channels: Partial<Record<ChannelName, ChannelAdapter>> = {}
  if (env.BC_TELEGRAM_BOT_TOKEN) {
    channels.telegram = new TelegramAdapter(env.BC_TELEGRAM_BOT_TOKEN)
    logger.info('telegram adapter configured')
  }
  if (env.BC_MAX_BOT_TOKEN) {
    channels.max = new MaxAdapter(env.BC_MAX_BOT_TOKEN)
    logger.info('max adapter configured')
  }

  // P1.5 — Desktop channel via WebSocket. Only registered when JWT secret is
  // configured (no JWT → wizard cannot issue tokens → no desktop clients).
  let desktopAdapter: DesktopAdapter | undefined
  let outboundDispatcher: OutboundDispatcher | undefined
  if (env.BC_JWT_SECRET) {
    desktopAdapter = new DesktopAdapter({
      verifyJwt: (token) => {
        const p = verifyJwt(token, env.BC_JWT_SECRET!)
        return p && typeof p.sub === 'string' ? { sub: p.sub } : null
      },
    })
    channels.desktop = desktopAdapter
    outboundDispatcher = new OutboundDispatcher()
    outboundDispatcher.registerDesktop(desktopAdapter)
    // Register non-desktop adapters as broadcast targets so the conversation
    // stays in sync across all channels the user has connected. Each adapter
    // only delivers if there's a corresponding ownerTgId/ownerMaxId on the
    // workspace (set by the original /start in that channel).
    if (channels.telegram) outboundDispatcher.registerPlain(channels.telegram)
    if (channels.max) outboundDispatcher.registerPlain(channels.max)
    logger.info('desktop adapter + outbound dispatcher configured', {
      plainTargets: Object.keys(channels).filter((k) => k !== 'desktop'),
    })
  }

  // WAVE3C-MERGE: per-workspace OAuth + MCP plumbing. Both opt-in: if
  // BC_OAUTH_ENC_KEY is missing OAuthRepo still constructs (lazy crypto), but
  // the integration tools will surface errors gracefully.
  const oauthRepo = new OAuthRepo(pool)
  const mcpServersRepo = new McpServersRepo(pool)
  const oauthResolver = new OAuthResolver({ oauthRepo })
  const mcpRegistry = new McpRegistry({
    pool,
    repo: mcpServersRepo,
    oauthResolver,
  })

  // FIX1.5: Wave 1C — per-workspace YAML skills. SkillManager needs a repo
  // (thin wrapper around `pool`) and a SkillLogger — pino's log() satisfies
  // the {info,warn,error} shape structurally.
  const skillsRepo = new SkillsRepo(pool)
  const skillManager = new SkillManager({ repo: skillsRepo, logger: log() })
  // FIX1.5: register skill cron triggers when boss is in scope — pg-boss is
  // not initialized in server.ts today, so nothing to register here yet.

  // FIX1.5: Wave 2A — Learner candidates repo, exposed via list/approve/reject
  // skill candidate tools on the root agent.
  const learnerCandidatesRepo = new LearnerCandidatesRepo(pool)
  // FIX1.5: register learner cron triggers when boss is in scope (see above).

  // FIX2: feedback service. Instantiated unconditionally so the telegram
  // callback handler can resolve refIds — the feature flag only gates whether
  // the keyboard is ATTACHED to outgoing messages (handled in router.ts).
  const feedbackRepo = new FeedbackRepo(pool)
  const feedbackService = new FeedbackService(feedbackRepo)
  const coachProposalsRepo = new CoachProposalsRepo(pool)
  if (channels.telegram && (channels.telegram as any).setFeedbackService) {
    ;(channels.telegram as any).setFeedbackService(feedbackService)
    logger.info('telegram feedback service attached')
  }

  // Bot router with runBetsy agent runner
  const runBetsyDeps = {
    wsRepo,
    personaRepo,
    factsRepo,
    convRepo,
    remindersRepo,
    s3: env.BC_S3_ACCESS_KEY ? getS3Storage() : ({} as any),
    gemini: getGemini(),
    agentRunner: async (
      agent: any,
      userMessage: string,
      history?: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>,
      inlineParts?: Array<{ inlineData: { mimeType: string; data: string } }>,
    ) => {
      return runWithGeminiTools(getGemini(), agent, userMessage, history ?? [], {
        inlineParts,
      })
    },
    mcpRegistry,
    oauthRepo,
    mcpServersRepo,
    // FIX1: instantiate Critic so BC_CRITIC_ENABLED=1 actually has effect in
    // both runBetsy and runBetsyStream paths. Fail-open by design.
    critic: new Critic({ gemini: getGemini() }),
    // FIX1.5: close Wave 1C / 2A wiring gaps.
    skillManager,
    learnerCandidatesRepo,
    // FIX2: expose feedback service to runner deps so future coach tools can query.
    feedbackService,
    // Fix3: CoachAgent persona tweak proposals — wires list/show/approve/reject
    // persona tweak tools onto the root agent. Nightly runner (pg-boss cron)
    // is not registered here yet — pg-boss isn't initialised in server.ts (see
    // learner cron TODO above).
    coachProposalsRepo,
    // P1.5 — cross-channel live mirror. Undefined when desktop adapter isn't
    // configured, which makes the bot-router / runner mirror calls a no-op.
    outboundDispatcher,
  }

  // P1.A — build TgLink components up-front so the router can route
  // `/start <nonce>` from the Windows-app wizard deep-link. Skipped silently
  // when the required env is not set (self-host installs that don't use the
  // hosted login flow).
  let tgLinkRepo: TgLinkRepo | undefined
  let tgLinkService: TgLinkService | undefined
  if (env.BC_TG_BOT_USERNAME && env.BC_JWT_SECRET) {
    tgLinkRepo = new TgLinkRepo(pool)
    tgLinkService = new TgLinkService(tgLinkRepo, {
      botUsername: env.BC_TG_BOT_USERNAME,
      jwtSecret: env.BC_JWT_SECRET,
    })
    logger.info('tg-link service ready', { botUsername: env.BC_TG_BOT_USERNAME })
  } else {
    logger.info('tg-link service skipped (BC_TG_BOT_USERNAME or BC_JWT_SECRET unset)')
  }

  const router = new BotRouter({
    wsRepo,
    personaRepo,
    factsRepo,
    convRepo,
    linkingSvc,
    channels,
    runBetsyFn: runBetsy,
    runBetsyStreamFn: runBetsyStream,
    runBetsyDeps,
    tgLinkService,
  })
  router.attach()

  for (const adapter of Object.values(channels)) {
    if (adapter) await adapter.start()
  }
  logger.info('channel adapters started', {
    channels: Object.keys(channels),
  })

  // Reminders worker
  const remindersWorker = startRemindersWorker(
    {
      wsRepo,
      remindersRepo,
      channels,
      resolveOwnerChatId: (w, ch) =>
        ch === 'telegram'
          ? (w.ownerTgId ? String(w.ownerTgId) : null)
          : w.ownerMaxId
            ? String(w.ownerMaxId)
            : null,
    },
    env.BC_REMINDERS_POLL_INTERVAL_MS,
  )
  remindersWorker.start()
  logger.info('reminders worker started', {
    intervalMs: env.BC_REMINDERS_POLL_INTERVAL_MS,
  })

  // Fix4: pg-boss init (fail-open — if Postgres is down for pg-boss schema
  // bootstrap, cron tasks are skipped but the rest of the service boots).
  let boss: any | undefined
  try {
    boss = new PgBoss({
      connectionString: env.BC_DATABASE_URL,
      schema: 'pgboss',
      retentionHours: 168,
    })
    boss.on('error', (err: unknown) => {
      // pg-boss sometimes emits plain objects (e.g. {code, severity, ...})
      // not Error instances. String(obj) → "[object Object]" is useless, so
      // we JSON-stringify with a fallback.
      let serialized: string
      if (err instanceof Error) {
        serialized = err.message
      } else if (err && typeof err === 'object') {
        try {
          serialized = JSON.stringify(err)
        } catch {
          serialized = '[unserializable]'
        }
      } else {
        serialized = String(err)
      }
      logger.warn('pg-boss error', { error: serialized })
    })
    await boss.start()
    logger.info('pg-boss started')
  } catch (e) {
    logger.warn('pg-boss failed to start, cron tasks disabled', {
      error: e instanceof Error ? e.message : String(e),
    })
    boss = undefined
  }

  // Fix4: runners used by both nightly cron registration and the admin
  // trigger endpoint. Constructed once so both code paths share state.
  const cronRunners: CronRunners = {
    learner: new Learner({
      pool,
      convRepo,
      skillsRepo,
      candidatesRepo: learnerCandidatesRepo,
      patternLLM: createGeminiPatternLLM(getGemini() as any),
      generatorLLM: createGeminiSkillGeneratorLLM(getGemini() as any),
      availableTools: () => [],
    }),
    skillManager,
    coach: new Coach({
      pool,
      feedbackRepo,
      convRepo,
      personaRepo,
      proposalsRepo: coachProposalsRepo,
      llm: createGeminiCoachLLM(getGemini() as any),
    }),
    // P1.A — only wire the sweep when the wizard flow is configured.
    ...(tgLinkRepo
      ? {
          tgLinkSweep: new TgLinkSweepRunner({
            repo: tgLinkRepo,
            logger: {
              info: (m, meta) => logger.info(m, meta),
              warn: (m, meta) => logger.warn(m, meta),
            },
          }),
        }
      : {}),
  }

  if (boss && process.env.BC_CRON_ENABLED !== '0') {
    await registerCronWiring(boss, cronRunners, logger)
  } else if (!boss) {
    logger.warn('cron wiring skipped (pg-boss unavailable)')
  } else {
    logger.info('cron wiring disabled via BC_CRON_ENABLED=0')
  }

  // Healthz (+ WAVE3C oauth relay callback mounted on the same port,
  // + Fix4 admin cron trigger endpoint).
  const relayHandler = createRelayCallbackHandler({
    oauthRepo,
    mcpServersRepo,
  })
  const adminCronHandler = createAdminCronHandler({
    runners: cronRunners,
    secret: process.env.BC_ADMIN_SECRET,
    logger,
  })
  const catalogPersonasHandler = createCatalogPersonasHandler()

  // P1.A — wire Telegram deep-link login HTTP endpoints. Only registered
  // when tgLinkService was constructed above; otherwise the wizard endpoints
  // stay 404 (acceptable for self-host installs that don't run the wizard).
  const tgLinkRoutes: { method: string; path: string; handler: any }[] = []
  if (tgLinkService && tgLinkRepo) {
    tgLinkRoutes.push(
      {
        method: 'POST',
        path: '/auth/tg-link/start',
        handler: createTgLinkStartHandler({ service: tgLinkService }),
      },
      {
        method: 'GET',
        path: '/auth/tg-link/poll',
        handler: createTgLinkPollHandler({ service: tgLinkService, repo: tgLinkRepo }),
      },
    )
    logger.info('tg-link endpoints registered')
  }

  // P1.5 — desktop chat history endpoint. Only registered when JWT secret is
  // configured (otherwise wizard-issued tokens cannot be verified anyway).
  const chatRoutes: { method: string; path: string; handler: any }[] = []
  if (env.BC_JWT_SECRET) {
    chatRoutes.push({
      method: 'GET',
      path: '/chat/history',
      handler: createHistoryHandler({
        verifyJwt: (token) => {
          const p = verifyJwt(token, env.BC_JWT_SECRET!)
          return p && typeof p.sub === 'string' ? { sub: p.sub } : null
        },
        listBefore: (ws, before, limit) => convRepo.listBefore(ws, before, limit),
      }),
    })
    logger.info('chat history endpoint registered')
  }

  const healthzServer = startHealthzServer(env.BC_HEALTHZ_PORT, pool, {
    extraRoutes: [
      { method: 'POST', path: '/oauth/token', handler: relayHandler },
      { method: 'POST', path: '/admin/cron/run', handler: adminCronHandler },
      { method: 'GET', path: '/catalog/personas', handler: catalogPersonasHandler },
      ...tgLinkRoutes,
      ...chatRoutes,
    ],
    // P1.5 — WS upgrade for /ws/chat goes through the DesktopAdapter.
    // No adapter → no upgrade handler → upgrades fall through to socket destroy.
    ...(desktopAdapter
      ? {
          upgrade: (req, socket, head) =>
            desktopAdapter!.handleUpgrade(req, socket, head),
        }
      : {}),
  })
  logger.info('healthz server listening', { port: env.BC_HEALTHZ_PORT })

  // Graceful shutdown — wait up to 5 min for in-flight tool work (selfie
  // generation can take 1-3 minutes via Nano Banana 3.1). Hard exit at 6 min.
  const shutdown = async (signal: string) => {
    logger.info('shutdown received', { signal })
    const hardTimeout = setTimeout(() => {
      logger.error('shutdown hard timeout, force exit')
      process.exit(1)
    }, 360_000)
    hardTimeout.unref()

    try {
      // Stop accepting NEW work first (router flips a flag, channels still
      // poll but new inbound is dropped). Then drain in-flight processBatch
      // promises so we don't kill running selfies / web searches.
      logger.info('shutdown: draining in-flight work')
      await router.drainInFlight(300_000)
      await remindersWorker.stop()
      if (boss) {
        try {
          await boss.stop({ graceful: true, timeout: 5000 })
          logger.info('pg-boss stopped')
        } catch (e) {
          logger.warn('pg-boss stop failed', { error: String(e) })
        }
      }
      for (const adapter of Object.values(channels)) {
        if (adapter) await adapter.stop()
      }
      await new Promise<void>((resolve) => healthzServer.close(() => resolve()))
      await closePool()
      logger.info('shutdown complete')
      process.exit(0)
    } catch (e) {
      logger.error('shutdown failed', { error: String(e) })
      process.exit(1)
    }
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))

  logger.info('betsy-multi started')
}
