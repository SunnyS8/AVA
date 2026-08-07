export interface BitrixEvent {
  event: string;
  dialogId: string;
  fromUserId: string;
  text: string;
  applicationToken: string;
  /**
   * Raw AUTHOR_ID as sent by the portal. The parser reports it and judges
   * nothing: deciding "this is our own bot talking" needs the bot's id, which
   * only the channel knows. Guessing here would be an unverified assumption
   * guarding the one thing that must not fail — the anti-loop check.
   */
  authorId: string;
  /**
   * Raw CHAT_TYPE as sent by the portal: "P" for a private (one-on-one)
   * dialog, "C" for a group chat. Empty string when the field is absent.
   * The parser reports it and judges nothing — same rule as authorId,
   * deciding what to do about it belongs to the channel.
   */
  chatType: string;
}

/**
 * Parses a Bitrix event body.
 *
 * Bitrix posts form-encoded data with bracketed keys, e.g.
 * `data[PARAMS][DIALOG_ID]`. Returns null when the body is not an event —
 * the caller answers 400 rather than guessing.
 */
export function parseBitrixEvent(body: string): BitrixEvent | null {
  if (!body) return null;

  const params = new URLSearchParams(body);
  const event = params.get("event");
  if (!event) return null;

  const p = (key: string) => params.get(`data[PARAMS][${key}]`) ?? "";

  return {
    event,
    dialogId: p("DIALOG_ID"),
    fromUserId: p("FROM_USER_ID"),
    text: p("MESSAGE"),
    applicationToken: params.get("auth[application_token]") ?? "",
    authorId: p("AUTHOR_ID"),
    chatType: p("CHAT_TYPE"),
  };
}
