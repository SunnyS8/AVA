export const MAX_MESSAGE_LEN = 8000;

/** Slicing can leave half of a surrogate pair behind, which renders as "�". */
function dropDanglingSurrogate(s: string, side: "end" | "start"): string {
  if (s.length === 0) return s;
  if (side === "end") {
    const last = s.charCodeAt(s.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
  }
  const first = s.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? s.slice(1) : s;
}

/**
 * Trims the middle out of a long text, keeping the head and the tail.
 * Bitrix cuts long messages itself, and the tail is usually the conclusion —
 * losing it is worse than losing the middle.
 */
export function clip(text: string, limit: number = MAX_MESSAGE_LEN): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 2);
  const tail = limit - head - 1;
  const start = dropDanglingSurrogate(text.slice(0, head), "end");
  const end = dropDanglingSurrogate(text.slice(text.length - tail), "start");
  return `${start}…${end}`;
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

    let res: Response;
    try {
      res = await this.fetchImpl(`${base}imbot.message.add.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ BOT_ID: this.botId, DIALOG_ID: dialogId, MESSAGE: clip(text) }),
      });
    } catch (err) {
      // fetch puts the whole URL — secret included — into its error message.
      // Only the error kind may leave this module.
      throw new Error(`Bitrix request failed: ${(err as Error).name}`);
    }

    if (!res.ok) {
      throw new Error(`Bitrix imbot.message.add failed: HTTP ${res.status}`);
    }

    // Bitrix answers 200 with an `error` field for application-level failures.
    // Treating that as success loses the message silently: the employee gets no
    // answer and nothing says why.
    const raw = await res.text();
    let data: { error?: string };
    try {
      data = JSON.parse(raw) as { error?: string };
    } catch {
      throw new Error("Bitrix imbot.message.add returned a non-JSON body");
    }
    if (data.error) {
      // error_description may echo request data — only the code goes out.
      throw new Error(`Bitrix imbot.message.add rejected: ${data.error}`);
    }
  }
}
