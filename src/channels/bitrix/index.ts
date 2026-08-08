import type { Channel, MessageHandler } from "../types.js";
import type { OutgoingMessage } from "../../core/types.js";
import { parseBitrixEvent, parseInstallEvent, type BitrixInstall } from "./event.js";
import { verifyEvent } from "./verify.js";
import { BitrixClient } from "./client.js";
import { DialogQueue } from "./queue.js";
import type { BitrixTokenStore } from "./tokens.js";

export interface BitrixChannelOptions {
  applicationToken?: string;
  botId?: string;
  client?: BitrixClient;
  /** Where install credentials are kept. Absent means installs are ignored. */
  tokenStore?: BitrixTokenStore;
  /** The one portal we serve, e.g. "example.bitrix24.ru". Normally derived
   *  from `webhook_url` in start(); an install from anywhere else is refused. */
  portalDomain?: string;
}

/** Event name a portal sends when the application is installed. */
const INSTALL_EVENT = "ONAPPINSTALL";

/**
 * Pulls the portal host out of a REST webhook URL.
 *
 * Returns undefined when the URL is absent or unparsable — and never the URL
 * itself, in a log or an error: a webhook URL carries its secret in the path.
 */
function portalDomainFromWebhook(webhookUrl: string | undefined): string | undefined {
  if (!webhookUrl) return undefined;
  try {
    return new URL(webhookUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Bitrix24 channel.
 *
 * Transport only: parse, verify, enqueue, send. Every decision about who may
 * ask what lives in the core — this class must stay dumb enough to reason
 * about at a glance.
 */
export class BitrixChannel implements Channel {
  name = "bitrix";
  requiredConfig = ["webhook_url", "application_token", "bot_id"];

  private handler: MessageHandler | null = null;
  private queue = new DialogQueue();
  private client: BitrixClient | null;
  private applicationToken: string | undefined;
  private botId: string | undefined;
  private tokenStore: BitrixTokenStore | null;
  private portalDomain: string | undefined;

  constructor(options: BitrixChannelOptions = {}) {
    this.client = options.client ?? null;
    this.applicationToken = options.applicationToken;
    this.botId = options.botId;
    this.tokenStore = options.tokenStore ?? null;
    this.portalDomain = options.portalDomain?.toLowerCase();
  }

  async start(config: Record<string, string>): Promise<void> {
    if (!this.handler) {
      throw new Error("BitrixChannel: call onMessage() before start()");
    }
    this.applicationToken = this.applicationToken ?? config.application_token;
    this.botId = this.botId ?? config.bot_id;
    if (!this.botId) {
      // Without our own id the anti-loop guard cannot tell our own messages
      // from anyone else's, and the bot would answer itself until the limits
      // run out. requiredConfig already declares bot_id mandatory — refuse to
      // start rather than run with the guard silently disabled.
      throw new Error("BitrixChannel: bot_id is required — the anti-loop guard depends on it");
    }
    this.portalDomain = this.portalDomain ?? portalDomainFromWebhook(config.webhook_url);
    this.client = this.client ?? new BitrixClient(config.webhook_url, this.botId);
  }

  async stop(): Promise<void> {
    await this.queue.idle();
  }

  /**
   * Sends into a Bitrix DIALOG. The `Channel` interface calls this first
   * parameter `userId`, but here it is a dialog id ("chat42"), not a person
   * ("17") — `IncomingMessage.userId` carries the person, and the two are not
   * interchangeable. Anything wiring proactive sends (scheduler, service
   * notifications) must pass the dialog id from `metadata.dialogId`.
   */
  async send(dialogId: string, message: OutgoingMessage): Promise<void> {
    await this.client?.sendMessage(dialogId, message.text);
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Resolves once queued work has settled. Used by tests and by stop(). */
  async idle(): Promise<void> {
    await this.queue.idle();
  }

  /**
   * Handles one webhook body. Returns the status to answer with — the answer
   * goes out immediately, the thinking happens in the queue. Bitrix retries
   * events we are slow to acknowledge.
   */
  handleWebhook(body: string): { status: number } {
    const event = parseBitrixEvent(body);
    if (!event) return { status: 400 };

    // Install is its own path and stops here: nothing to answer, no one to
    // answer to, and the model has no business being woken by it. It is also
    // handled BEFORE verifyEvent — the token an install would be verified
    // against is the one the install itself delivers.
    if (event.event === INSTALL_EVENT) return this.handleInstall(body);

    if (!verifyEvent(event, this.applicationToken)) {
      console.warn("bitrix: event rejected, token mismatch");
      return { status: 401 };
    }

    // No sender, no processing. This isn't just "the field happened to be
    // empty" — an empty fromUserId is also the key SchedulerService looks up
    // per-user context by (setMessageContext/contextByUser in
    // src/core/tools/scheduler.ts). A malformed or partial webhook missing
    // FROM_USER_ID that lands while a real dialog is in flight would fall
    // through to the scheduler's single-slot fallback and inherit whatever
    // OTHER conversation's channel/chatId was set most recently — exactly
    // the cross-dialog leak the per-user Map was built to close. There is
    // also no one to answer, so refusing outright costs nothing.
    if (!event.fromUserId) return { status: 200 };

    // Anti-loop. We compare against the id we registered the bot with, not a
    // guessed constant: this guard is the only thing standing between us and a
    // bot answering itself forever, and it must not rest on an assumption.
    if (this.botId && (event.authorId === this.botId || event.fromUserId === this.botId)) {
      return { status: 200 };
    }
    // AUTHOR_ID=0 marks portal system messages — nothing to answer there either.
    if (event.authorId === "0") return { status: 200 };
    if (!event.text) return { status: 200 };

    // Spec: Ava answers only one-on-one dialogs, never group chats — a group
    // reply on every message would spam a shared work chat. Bitrix marks a
    // private dialog CHAT_TYPE="P" and a group one "C". An EMPTY chatType
    // (field absent — e.g. an older portal build, or a payload shape we
    // haven't seen) is treated as private and answered: the alternative,
    // treating unknown as group, would silence the bot everywhere the moment
    // the portal ever omits the field. A wrongly-answered group message once
    // in a while is a much cheaper mistake than the bot going mute for good.
    if (event.chatType && event.chatType !== "P") return { status: 200 };

    const handler = this.handler;
    const client = this.client;
    if (!handler || !client) return { status: 200 };

    this.queue.enqueue(event.dialogId, async () => {
      try {
        const answer = await handler({
          channelName: "bitrix",
          userId: event.fromUserId,
          text: event.text,
          timestamp: Date.now(),
          metadata: { dialogId: event.dialogId },
        });
        await client.sendMessage(event.dialogId, answer.text);
      } catch (err) {
        console.error("bitrix: failed to answer", (err as Error).message);
        await client
          .sendMessage(event.dialogId, "Не смогла ответить, попробуйте позже.")
          .catch(() => undefined);
      }
    });

    return { status: 200 };
  }

  /**
   * Stores the credentials a portal delivers when it installs the application.
   *
   * An install event cannot be authenticated: `application_token` — the only
   * shared secret there is — arrives inside the very event that establishes
   * it, so there is nothing prior to compare it against. Nor is a forged
   * install harmless. The handler address is public, so anyone who knows it
   * can post an ONAPPINSTALL of their own; landing first, before the owner
   * installs, it would both squat the token file (every later real install
   * then bounces off the memberId check until someone deletes the file by
   * hand) and, once the client starts calling the portal named in the store,
   * point Ava's answers at the stranger's domain.
   *
   * So an install is accepted only from the ONE portal we are configured to
   * serve, and only when it does not overwrite another portal's tokens:
   *
   *   1. `domain` must equal the portal domain from settings. Unknown domain
   *      means refuse — a forgotten setting must close the door, not open it.
   *   2. `memberId` must match whatever is already stored, if anything is.
   */
  private handleInstall(body: string): { status: number } {
    const install = parseInstallEvent(body);
    if (!install) {
      // The parser already logged which field was missing. Retrying will not
      // conjure it up, so this is a 400 and not a "try again later".
      return { status: 400 };
    }

    const store = this.tokenStore;
    if (!store) {
      console.warn("bitrix: install event received, but no token store is configured — tokens not saved");
      return { status: 200 };
    }

    // Deny by default: without a known portal domain there is nothing to
    // check an install against, and accepting it would hand the token file to
    // whoever posted first. Answered non-2xx so the portal reports the
    // install as failed instead of showing a success no one can use.
    if (!this.portalDomain) {
      console.error(
        "bitrix: установка отклонена — в настройках не задан адрес портала (webhook_url). " +
          "Укажите адрес портала и установите приложение заново.",
      );
      return { status: 400 };
    }

    if (install.domain.toLowerCase() !== this.portalDomain) {
      console.warn("bitrix: install event from another portal ignored — tokens not saved");
      return { status: 200 };
    }

    const existing = store.load();
    if (existing && existing.memberId !== install.memberId) {
      console.warn("bitrix: install event from another portal ignored — existing tokens kept");
      return { status: 200 };
    }

    return this.saveInstall(store, install) ? { status: 200 } : { status: 500 };
  }

  /** Returns false when the tokens did not reach the disk. */
  private saveInstall(store: BitrixTokenStore, install: BitrixInstall): boolean {
    try {
      store.save({
        accessToken: install.accessToken,
        refreshToken: install.refreshToken,
        // The portal sends a lifetime, we store a deadline: a lifetime is
        // meaningless the moment it is read back off disk.
        expiresAt: Date.now() + install.expiresIn * 1000,
        // Stored lowercased — it was matched that way, and whatever builds
        // portal URLs from it later should not have to wonder about case.
        domain: install.domain.toLowerCase(),
        memberId: install.memberId,
      });
      console.log("bitrix: application installed, tokens saved");
      return true;
    } catch (err) {
      // The errno code and nothing else: it names the real cause (EACCES,
      // ENOSPC) and carries no secret, while the message around it can carry
      // the path and `err.name` is "Error" for every filesystem failure.
      const code = (err as NodeJS.ErrnoException).code;
      console.error(`bitrix: failed to save install tokens (${code ?? "unknown error"})`);
      return false;
    }
  }
}
