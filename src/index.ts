import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "./server.js";
import { isConfigured, loadConfig, saveConfig, getAgentName, getPersonality, getPersonalitySliders, getLLMApiKey } from "./core/config.js";
import { TelegramChannel } from "./channels/telegram/index.js";
import { BitrixChannel } from "./channels/bitrix/index.js";
import { buildBitrixHandler, planBitrixStartup } from "./channels/bitrix/wiring.js";
import { createBitrixTokenStore } from "./channels/bitrix/tokens.js";
import { RateLimiter } from "./core/limits.js";
import { LLMRouter } from "./core/llm/router.js";
import { Engine } from "./core/engine.js";
import { ToolRegistry } from "./core/tools/registry.js";
import { ShellTool } from "./core/tools/shell.js";
import { FilesTool } from "./core/tools/files.js";
import { HttpTool } from "./core/tools/http.js";
import { BrowserTool } from "./core/tools/browser.js";
import { WebTool } from "./core/tools/web.js";
import { memoryTool } from "./core/tools/memory.js";
import { selfConfigTool } from "./core/tools/self-config.js";
import { SchedulerService } from "./core/tools/scheduler.js";
import { SchedulerStore } from "./core/tools/scheduler-store.js";
import { getDB } from "./core/memory/db.js";
import type { Channel } from "./channels/types.js";
import { sshTool } from "./core/tools/ssh.js";
import { npmInstallTool } from "./core/tools/npm-install.js";
import { SelfieTool } from "./core/tools/selfie.js";
import { VideoMessageTool } from "./core/tools/video.js";
import { ImageGenTool } from "./core/tools/image-gen.js";
import { SkillSearchTool } from "./core/tools/skill-search.js";
import { SkillInstallTool } from "./core/tools/skill-install.js";
import { SendFileTool } from "./core/tools/send-file.js";
import { ConnectServiceTool } from "./core/tools/connect-service.js";
import { buildConnectNotifyHandler } from "./channels/connect-notify.js";
import { computeTelegramAccess } from "./channels/telegram/access.js";
import { pickEntry } from "./mode.js";
import { isToolEnabled } from "./core/tools-enabled.js";

function getAddress(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

async function main() {
  if (pickEntry(process.env) === 'multi') {
    const { startMultiServer } = await import('./multi/server.js');
    await startMultiServer();
    return;
  }

  const port = 3777;
  const address = getAddress();

  const config = isConfigured() ? loadConfig() : null;
  const name = config ? getAgentName(config) : "Betsy";

  console.log(`🦀 ${name} запускается...`);
  console.log(`🌐 Открой в браузере: http://${address}:${port}`);

  if (!config) {
    console.log("📋 Конфиг не найден — открой визард в браузере");
    const { server, wss } = createServer({ port });
    setupShutdown(server, wss);
    return;
  }

  console.log(`✅ Конфиг загружен: ${name}`);

  // Setup LLM
  const apiKey = getLLMApiKey(config);
  let llm: LLMRouter | null = null;

  if (apiKey) {
    const llmConfig = config.llm as any;
    if (llmConfig.fast) {
      llm = new LLMRouter({
        provider: llmConfig.fast.provider,
        api_key: llmConfig.fast.api_key,
        fast_model: llmConfig.fast.model,
        strong_model: llmConfig.strong?.model ?? llmConfig.fast.model,
        fallback_models: llmConfig.fallback_models,
        base_url: llmConfig.fast.base_url ?? llmConfig.strong?.base_url,
        proxy: llmConfig.fast.proxy ?? llmConfig.strong?.proxy,
      });
    } else {
      llm = new LLMRouter({
        provider: llmConfig.provider,
        api_key: llmConfig.api_key,
        fast_model: llmConfig.fast_model,
        strong_model: llmConfig.strong_model,
        fallback_models: llmConfig.fallback_models,
        base_url: llmConfig.base_url,
        proxy: llmConfig.proxy,
      });
    }
    // Адрес прокси содержит логин и пароль — в журнал он не попадает.
    const viaProxy = llmConfig.proxy ?? llmConfig.fast?.proxy ?? llmConfig.strong?.proxy;
    console.log(`✅ LLM подключён${viaProxy ? " (через прокси)" : ""}`);
  }

  // Register tools
  const tools = new ToolRegistry();
  const schedulerDb = getDB();
  const schedulerStore = new SchedulerStore(schedulerDb);
  schedulerStore.init();
  const scheduler = new SchedulerService(schedulerStore);
  const securityTools = config.security?.tools;
  if (isToolEnabled("shell", securityTools)) tools.register(new ShellTool());
  tools.register(new SendFileTool());
  tools.register(new FilesTool());
  const passwordHash = config.security?.password_hash ?? "default-key-change-me";
  tools.register(new HttpTool({ encryptionKey: passwordHash }));
  if (isToolEnabled("browser", securityTools)) tools.register(new BrowserTool());
  tools.register(memoryTool);
  tools.register(selfConfigTool);
  tools.register(scheduler.tool);
  if (isToolEnabled("ssh", securityTools)) tools.register(sshTool);
  if (isToolEnabled("npm_install", securityTools)) tools.register(npmInstallTool);
  // channels map is populated later — closure captures the reference
  const channels = new Map<string, Channel>();
  tools.register(new ConnectServiceTool({
    encryptionKey: passwordHash,
    // `engine` below is assigned further down this function, after tools are
    // registered — getEngine() is looked up lazily each time a connection
    // completes, well after main() has finished its synchronous setup.
    onConnected: buildConnectNotifyHandler({ channels, getEngine: () => engine }),
  }));
  // Selfie tool — uses fal.ai key from selfies config, falls back to video config
  const selfiesConfig = config.selfies as Record<string, string> | undefined;
  const videoConfig = config.video as Record<string, string> | undefined;
  const selfieTool = new SelfieTool({
    falApiKey: selfiesConfig?.fal_api_key ?? videoConfig?.fal_api_key ?? "",
    referencePhotoUrl: selfiesConfig?.reference_photo_url,
  });
  tools.register(selfieTool);
  // Video message (circle) tool — lip-sync talking head via fal.ai
  const videoTool = new VideoMessageTool({
    voiceConfig: (config.voice as Record<string, unknown>) ?? {},
    falApiKey: selfiesConfig?.fal_api_key ?? videoConfig?.fal_api_key ?? "",
    avatarPath: () => {
      const ref = path.join(os.homedir(), ".betsy", "reference.jpg");
      return fs.existsSync(ref) ? ref : path.join(os.homedir(), ".betsy", "avatar.jpg");
    },
  });
  tools.register(videoTool);
  // Image generation tool — uses OpenRouter API key
  const llmApiKey = getLLMApiKey(config);
  if (llmApiKey) {
    tools.register(new ImageGenTool({ apiKey: llmApiKey }));
  }
  // SkillsMP tools — search and install agent skills
  const skillsmpKey = (config as any).skillsmp?.api_key as string | undefined;
  if (skillsmpKey) {
    tools.register(new SkillSearchTool({ apiKey: skillsmpKey }));
    tools.register(new SkillInstallTool({ apiKey: llmApiKey ?? undefined }));
  }
  // Web tool — conditional on google config
  const googleConfig = (config as any).google as { api_key: string; cx: string } | undefined;
  if (googleConfig?.api_key && googleConfig?.cx) {
    tools.register(new WebTool({ apiKey: googleConfig.api_key, cx: googleConfig.cx }));
  }
  console.log(`🔧 Зарегистрировано инструментов: ${tools.list().length}`);

  // Setup Engine with personality and tools
  const personality = getPersonality(config);
  const engine = llm ? new Engine({
    llm,
    config: {
      name,
      gender: config.agent?.gender ?? "female",
      personality: {
        tone: personality.tone,
        responseStyle: personality.style,
        customInstructions: personality.customInstructions,
      },
      personalitySliders: getPersonalitySliders(config),
      owner: config.owner,
    },
    tools,
    contextBudget: config.memory?.context_budget ?? 40000,
    encryptionKey: passwordHash,
  }) : null;

  // Start Bitrix channel
  let bitrix: BitrixChannel | null = null;
  if (config.bitrix) {
    // Real store, in the config directory: an ONAPPINSTALL from the portal
    // must land on disk, not in the "no token store configured" branch. It is
    // also what tells the startup plan whether the install has already
    // happened — the key it delivers never reaches the config.
    const tokenStore = createBitrixTokenStore();
    const plan = planBitrixStartup(config.bitrix, tokenStore.load() !== null);
    console.log(`${plan.start ? "ℹ️" : "⚠️"} ${plan.message}`);
    if (plan.start) {
      try {
        const limiter = new RateLimiter(
          config.profiles?.limits.per_hour ?? 15,
          config.profiles?.limits.per_day_total ?? 300,
        );
        const bitrixChannel = new BitrixChannel({ tokenStore });
        bitrixChannel.onMessage(
          buildBitrixHandler({
            ask: async (msg, profile, access) => {
              if (!engine) return { text: "Я сейчас не могу ответить — модель не подключена." };
              // Same order as the Telegram wiring below: the scheduler must know
              // where to answer before the engine starts thinking. Keyed by
              // msg.userId so concurrent dialogs (the Bitrix queue runs
              // different dialogs in parallel) don't clobber each other's
              // context — see the Map in SchedulerService.
              scheduler.setMessageContext(msg.userId, msg.channelName, msg.userId, engine.getHistory(msg.userId) ?? []);
              // Права на платную генерацию — из профиля: видео стоит около двух
              // долларов за ролик, поэтому решает поимённый список
              // (profiles.video_ids / voice_ids), а не общий уровень доступа.
              return engine.process(msg, undefined, access, { video: profile.video, voice: profile.voice });
            },
            profiles: config.profiles,
            limiter,
          }),
        );
        // Empty string, not undefined: start() reports what is missing in
        // Russian, and the catch below turns that into one clear line for the
        // owner instead of a channel that half-works for an hour.
        await bitrixChannel.start({
          webhook_url: config.bitrix.webhook_url,
          application_token: config.bitrix.application_token ?? "",
          bot_id: config.bitrix.bot_id ?? "",
          client_id: config.bitrix.client_id ?? "",
          client_secret: config.bitrix.client_secret ?? "",
        });
        bitrix = bitrixChannel;
        channels.set("bitrix", bitrix);
        console.log("✅ Канал Битрикс запущен");
      } catch (err) {
        // A failed start must not take the whole process down with it:
        // `bitrix` stays null, createServer() gets `undefined`, and the rest of
        // the app — Telegram included — starts normally.
        console.error("❌ Канал Битрикс не поднялся, причина:", err instanceof Error ? err.message : err);
        console.log("⚠️ Битрикс отключён на этот запуск, остальное работает как обычно");
      }
    }
  }

  // Start HTTP server
  const { server, wss } = createServer({ port, engine: engine ?? undefined, bitrix: bitrix ?? undefined });

  // Start Telegram channel
  let telegram: TelegramChannel | null = null;
  if (config.telegram?.token) {
    try {
      telegram = new TelegramChannel();
      telegram.onOwnerClaimed = (chatId) => {
        config.telegram!.owner_id = chatId;
        saveConfig(config);
        console.log(`🔒 Owner ID ${chatId} сохранён в конфиг`);
      };
      telegram.onSetReferencePhoto = (photoPath) => {
        selfieTool.setReferencePhoto(photoPath);
        console.log(`📸 Референсное фото обновлено: ${photoPath.slice(0, 60)}`);
      };
      telegram.onMessage(async (msg, onProgress) => {
        if (engine) {
          // Access is computed from who actually sent the message
          // (msg.userId, keyed by sender — see resolveTelegramIds in
          // channels/telegram/handlers.ts), compared against the configured
          // owner. This is what makes public mode safe: a stranger in a
          // group or DM gets exactly the restricted tools an employee gets
          // in the portal, never the owner's.
          const access = computeTelegramAccess(msg.userId, config.telegram!.owner_id);
          // chatId (falls back to userId in a 1:1 chat) is the address a
          // scheduled task must reply into later — kept separate from the
          // sender-keyed userId above so a group reminder doesn't get sent
          // to whichever member happened to create it.
          scheduler.setMessageContext(
            msg.userId,
            msg.channelName,
            msg.chatId ?? msg.userId,
            engine.getHistory(msg.userId) ?? [],
          );
          return engine.process(msg, onProgress, access);
        }
        return { text: "LLM не настроен. Открой дашборд для настройки." };
      });
      // Set media config BEFORE start() so handlers see the fal key at registration time
      telegram.mediaConfig = {
        voiceConfig: (config.voice as Record<string, unknown>) ?? {},
        falApiKey: selfiesConfig?.fal_api_key ?? videoConfig?.fal_api_key ?? "",
        avatarPath: () => {
          const ref = path.join(os.homedir(), ".betsy", "reference.jpg");
          return fs.existsSync(ref) ? ref : path.join(os.homedir(), ".betsy", "avatar.jpg");
        },
      };
      // Set public mode BEFORE start() so the owner-only filter is not registered
      const channelTelegramCfg = (config.channels as Record<string, any> | undefined)?.telegram;
      telegram.allowAll = channelTelegramCfg?.public === true || channelTelegramCfg?.enabled_public === true;
      await telegram.start({
        token: config.telegram.token,
        owner_chat_id: config.telegram.owner_id?.toString() ?? "",
      });
      // Load saved reference photo if exists and no URL in config
      const savedRef = path.join(os.homedir(), ".betsy", "reference.jpg");
      if (!selfieTool.config.referencePhotoUrl && fs.existsSync(savedRef)) {
        selfieTool.setReferencePhoto(savedRef);
        console.log("📸 Референсное фото загружено из ~/.betsy/reference.jpg");
      }
      console.log("✅ Telegram бот запущен");
    } catch (err) {
      console.error("❌ Telegram ошибка:", err instanceof Error ? err.message : err);
    }
  }

  if (telegram) {
    channels.set("telegram", telegram);
    // Download bot avatar as fallback for video circles if no reference photo yet
    const refPath = path.join(os.homedir(), ".betsy", "reference.jpg");
    const avatarPath = path.join(os.homedir(), ".betsy", "avatar.jpg");
    if (!fs.existsSync(refPath) && telegram.avatarUrl && !fs.existsSync(avatarPath)) {
      try {
        const res = await fetch(telegram.avatarUrl);
        if (res.ok) {
          fs.writeFileSync(avatarPath, Buffer.from(await res.arrayBuffer()));
          console.log("📸 Аватарка бота сохранена для видео");
        }
      } catch (err) {
        console.error("❌ Не удалось скачать аватарку:", err instanceof Error ? err.message : err);
      }
    }
    // Media config is set before telegram.start() above
  }

  if (engine) {
    scheduler.onTaskFire(async (task) => {
      const channel = channels.get(task.channel);
      if (!channel) {
        console.error(`Scheduler: channel "${task.channel}" not available for task "${task.name}"`);
        return;
      }

      const prompt = [
        `Сработало запланированное задание "${task.name}".`,
        `Задача: ${task.command}`,
        task.context ? `\nКонтекст разговора при создании задачи:\n${task.context}` : "",
        `\nНапиши владельцу сообщение в связи с этой задачей.`,
      ].join("\n");

      try {
        // Deliberately "restricted", not "owner": a scheduled task can have
        // been created by anyone who once talked to the scheduler tool —
        // ScheduledTaskRow has no creator field, so there is currently no
        // way to recover who that was when the task fires later. Do not
        // "fix" this to "owner" without first adding that tracking.
        const result = await engine.process({
          channelName: task.channel,
          userId: task.chatId,
          text: prompt,
          timestamp: Date.now(),
          metadata: { scheduledTask: true },
        }, undefined, "restricted");
        await channel.send(task.chatId, result);
        console.log(`✅ Scheduler: delivered "${task.name}" to ${task.channel}:${task.chatId}`);
      } catch (err) {
        console.error(`❌ Scheduler: failed to deliver "${task.name}":`, err);
      }
    });

    await scheduler.recoverMissed();
    scheduler.start();
    console.log("✅ Планировщик запущен");
  }

  // Auto-open browser on local machine
  if (os.platform() !== "linux") {
    const { execFile: execFileCb } = await import("node:child_process");
    const opener = os.platform() === "darwin" ? "open" : os.platform() === "win32" ? "start" : "xdg-open";
    execFileCb(opener, [`http://localhost:${port}`], () => {});
  }

  setupShutdown(server, wss, scheduler, llm ?? undefined);
}

function setupShutdown(server: any, wss: any, scheduler?: SchedulerService, router?: LLMRouter) {
  const shutdown = () => {
    console.log("\nЗавершение работы...");
    scheduler?.stop();
    router?.destroy();
    wss.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
