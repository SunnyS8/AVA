import type { Channel, MessageHandler } from "../types.js";
import type { OutgoingMessage } from "../../core/types.js";
import { parseBitrixEvent } from "./event.js";
import { verifyEvent } from "./verify.js";
import { BitrixClient } from "./client.js";
import { DialogQueue } from "./queue.js";

export interface BitrixChannelOptions {
  applicationToken?: string;
  botId?: string;
  client?: BitrixClient;
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

  constructor(options: BitrixChannelOptions = {}) {
    this.client = options.client ?? null;
    this.applicationToken = options.applicationToken;
    this.botId = options.botId;
  }

  async start(config: Record<string, string>): Promise<void> {
    if (!this.handler) {
      throw new Error("BitrixChannel: call onMessage() before start()");
    }
    this.applicationToken = this.applicationToken ?? config.application_token;
    this.botId = this.botId ?? config.bot_id;
    this.client = this.client ?? new BitrixClient(config.webhook_url, config.bot_id);
  }

  async stop(): Promise<void> {
    await this.queue.idle();
  }

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

    if (!verifyEvent(event, this.applicationToken)) {
      console.warn("bitrix: event rejected, token mismatch");
      return { status: 401 };
    }

    // Anti-loop. We compare against the id we registered the bot with, not a
    // guessed constant: this guard is the only thing standing between us and a
    // bot answering itself forever, and it must not rest on an assumption.
    if (this.botId && (event.authorId === this.botId || event.fromUserId === this.botId)) {
      return { status: 200 };
    }
    // AUTHOR_ID=0 marks portal system messages — nothing to answer there either.
    if (event.authorId === "0") return { status: 200 };
    if (!event.text) return { status: 200 };

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
}
