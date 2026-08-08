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

/**
 * Credentials a portal hands over when it installs the application.
 *
 * `expiresIn` is the raw lifetime in seconds as sent by the portal — turning
 * it into a wall-clock deadline needs "now", and picking which clock to read
 * is a decision, not parsing.
 */
export interface BitrixInstall {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  domain: string;
  memberId: string;
  applicationToken: string;
}

/** Every `auth[...]` field an install must carry as a non-empty string. */
const REQUIRED_INSTALL_STRING_FIELDS = [
  "access_token",
  "refresh_token",
  "domain",
  "member_id",
  "application_token",
] as const;

/**
 * Finds the first required field an install body is missing.
 *
 * Same rule as `findMissingOAuthField` in tokens.ts: an incomplete install is
 * not a partial success. A body with an access token but no refresh token
 * would store a credential that dies in an hour with no way to renew it, and
 * the failure would surface much later as an unrelated-looking auth error.
 */
function findMissingInstallField(params: URLSearchParams): string | undefined {
  for (const field of REQUIRED_INSTALL_STRING_FIELDS) {
    const value = params.get(`auth[${field}]`);
    if (value === null || value === "") return field;
  }
  // Form data is all strings, so expires_in always needs coercion. Number()
  // is deliberate and explicit: it accepts "3600" and rejects garbage,
  // instead of quietly producing NaN downstream.
  const expiresIn = params.get("auth[expires_in]");
  if (expiresIn === null || expiresIn === "" || Number.isNaN(Number(expiresIn))) {
    return "expires_in";
  }
  return undefined;
}

/**
 * Parses an application install body.
 *
 * Bitrix posts it form-encoded with bracketed keys, e.g. `auth[access_token]`.
 * Returns null when the body does not carry a complete set of credentials —
 * and judges nothing beyond that. Whether these tokens may replace the ones
 * already on disk is the channel's call, not the parser's.
 */
export function parseInstallEvent(body: string): BitrixInstall | null {
  if (!body) return null;

  const params = new URLSearchParams(body);
  const missing = findMissingInstallField(params);
  if (missing) {
    // The field NAME only. A half-complete body still carries a live token in
    // whichever fields did arrive, so the body itself never reaches the log.
    console.error(`bitrix install: body is incomplete, missing auth[${missing}]`);
    return null;
  }

  return {
    accessToken: params.get("auth[access_token]") as string,
    refreshToken: params.get("auth[refresh_token]") as string,
    expiresIn: Number(params.get("auth[expires_in]")),
    domain: params.get("auth[domain]") as string,
    memberId: params.get("auth[member_id]") as string,
    applicationToken: params.get("auth[application_token]") as string,
  };
}
