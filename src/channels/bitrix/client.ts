export const MAX_MESSAGE_LEN = 8000;

/**
 * Trims the middle out of a long text, keeping the head and the tail.
 * Bitrix cuts long messages itself, and the tail is usually the conclusion —
 * losing it is worse than losing the middle.
 */
export function clip(text: string, limit: number = MAX_MESSAGE_LEN): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 2);
  const tail = limit - head - 1;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * Bitrix REST over an incoming webhook.
 *
 * The webhook URL is a secret: it never leaves this class and never appears
 * in an error message or a log line.
 */
export class BitrixClient {
  constructor(
    private webhookUrl: string,
    private botId: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async sendMessage(dialogId: string, text: string): Promise<void> {
    const base = this.webhookUrl.endsWith("/") ? this.webhookUrl : `${this.webhookUrl}/`;
    const res = await this.fetchImpl(`${base}imbot.message.add.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ BOT_ID: this.botId, DIALOG_ID: dialogId, MESSAGE: clip(text) }),
    });

    if (!res.ok) {
      // Deliberately no URL in the message — it carries the secret.
      throw new Error(`Bitrix imbot.message.add failed: HTTP ${res.status}`);
    }
  }
}
