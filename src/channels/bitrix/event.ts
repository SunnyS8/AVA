export interface BitrixEvent {
  event: string;
  dialogId: string;
  fromUserId: string;
  text: string;
  applicationToken: string;
  /** Bitrix reports AUTHOR_ID=0 for bot-sent messages. */
  fromBot: boolean;
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
    fromBot: params.get("data[PARAMS][AUTHOR_ID]") === "0",
  };
}
