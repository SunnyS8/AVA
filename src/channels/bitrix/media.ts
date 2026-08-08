import fs from "node:fs";
import path from "node:path";
import type { OutgoingMessage } from "../../core/types.js";

/**
 * How much media we are willing to pull into memory and base64-encode.
 *
 * The whole file becomes a string in the request body, and base64 inflates it
 * by a third — an unbounded read here is how a single long video takes the
 * process down. 20 MB is far above anything Ava produces (a video note is a
 * couple of megabytes) and far below trouble.
 */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/** A file ready to go to the portal: a name to show and the bytes themselves. */
export interface MediaPayload {
  name: string;
  bytes: Buffer;
}

/** What kind of thing Ava made — decides how the apology reads in Russian. */
export type MediaKind = "video" | "voice" | "photo" | "file";

/**
 * Why media did not reach the chat.
 *
 * - `missing`   — the file is not where it was promised, or a download failed
 * - `too_big`   — over MAX_MEDIA_BYTES
 * - `unsupported` — a reference we cannot turn into bytes at all
 * - `portal`    — the portal refused the upload (no `disk` right, or anything else)
 */
export type MediaFailure = "missing" | "too_big" | "unsupported" | "portal";

/** Thrown while turning an OutgoingMessage into bytes. Carries the reason so
 *  the channel can say the right thing, never the underlying error text —
 *  which may quote a path or a portal answer. */
export class MediaLoadError extends Error {
  constructor(readonly reason: MediaFailure) {
    super(`media unavailable: ${reason}`);
    this.name = "MediaLoadError";
  }
}

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mkv", ".avi", ".mov"]);
const AUDIO_EXTS = new Set([".mp3", ".ogg", ".wav", ".flac", ".m4a", ".aac", ".opus"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);

/** Extension for a data: URL, keyed by the part of the MIME type that matters. */
const EXT_BY_SUBTYPE: Record<string, string> = {
  jpeg: "jpg",
  jpg: "jpg",
  png: "png",
  webp: "webp",
  gif: "gif",
  mp4: "mp4",
  webm: "webm",
  mpeg: "mp3",
  ogg: "ogg",
  wav: "wav",
};

/** What Ava is sending, from the mode she chose and the file she produced. */
export function mediaKind(message: OutgoingMessage): MediaKind {
  const ext = message.mediaPath ? path.extname(message.mediaPath).toLowerCase() : "";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "voice";
  if (IMAGE_EXTS.has(ext)) return "photo";
  if (message.mode === "video") return "video";
  if (message.mode === "voice") return "voice";
  if (message.mode === "selfie") return "photo";
  if (message.mediaUrl) return "photo";
  return "file";
}

/** Does this answer carry media at all? Nothing here means the old text path. */
export function hasMedia(message: OutgoingMessage): boolean {
  return Boolean(message.mediaPath || message.mediaUrl);
}

const OPENING: Record<MediaKind, string> = {
  video: "Видео я записала",
  voice: "Голосовое я записала",
  photo: "Картинку я сделала",
  file: "Файл я подготовила",
};

const IT: Record<MediaKind, string> = {
  video: "его",
  voice: "его",
  photo: "её",
  file: "его",
};

/**
 * What Ava says when the media cannot go out.
 *
 * Deliberately plain Russian with no error code in it: the person on the other
 * end asked for a video, not for a diagnosis. The code and the HTTP status go
 * to the log, where they are useful — see BitrixChannel.deliver().
 */
export function apology(kind: MediaKind, failure: MediaFailure): string {
  const it = IT[kind];
  switch (failure) {
    case "missing":
      return `${OPENING[kind]}, но сам файл до меня не доехал — отправить ${it} не получилось. Оставляю ответ текстом.`;
    case "too_big":
      return `${OPENING[kind]}, но получилось слишком тяжело для Битрикса (больше ${Math.floor(MAX_MEDIA_BYTES / (1024 * 1024))} МБ) — отправить ${it} не выйдет. Оставляю ответ текстом.`;
    case "unsupported":
      return `${OPENING[kind]}, но такое вложение я в Битрикс отправлять не умею. Оставляю ответ текстом.`;
    case "portal":
      return `${OPENING[kind]}, но отправить ${it} в Битрикс не получилось — здесь я пока умею только текстом.`;
  }
}

/** Glues the answer and the apology into ONE message: both must arrive, and a
 *  single call cannot half-succeed the way two calls can. */
export function withApology(text: string, kind: MediaKind, failure: MediaFailure): string {
  const said = apology(kind, failure);
  return text.trim() ? `${text}\n\n${said}` : said;
}

/** Strips anything that could steer the name out of the folder it belongs in. */
function safeName(name: string, fallback: string): string {
  const base = path.basename(name).replace(/[\/:*?"<>|]/g, "").trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 120) : fallback;
}

/** Reads a local file, refusing before the read when it is too big to hold. */
function loadFromPath(filePath: string): MediaPayload {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    // Missing, unreadable, a directory — all the same to the person waiting.
    throw new MediaLoadError("missing");
  }
  if (size > MAX_MEDIA_BYTES) throw new MediaLoadError("too_big");

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    throw new MediaLoadError("missing");
  }
  return { name: safeName(filePath, "media"), bytes };
}

/** Decodes a `data:` URL. Only base64 payloads — a percent-encoded one would
 *  need different handling and Ava never produces them. */
function loadFromDataUrl(url: string): MediaPayload {
  const match = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(url);
  if (!match) throw new MediaLoadError("unsupported");
  const [, mime, params, data] = match;
  if (!(params ?? "").includes("base64")) throw new MediaLoadError("unsupported");

  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0) throw new MediaLoadError("missing");
  if (bytes.length > MAX_MEDIA_BYTES) throw new MediaLoadError("too_big");

  const subtype = (mime.split("/")[1] ?? "").toLowerCase();
  return { name: `media.${EXT_BY_SUBTYPE[subtype] ?? "bin"}`, bytes };
}

/** Downloads an http(s) media URL — what image tools hand back. */
async function loadFromHttpUrl(url: URL, fetchImpl: typeof fetch): Promise<MediaPayload> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch {
    // fetch bakes the whole request into its message; nothing from it escapes.
    throw new MediaLoadError("missing");
  }
  if (!res.ok) throw new MediaLoadError("missing");

  // Trust the declared length enough to refuse early, and check again after
  // the read — a wrong or absent header must not become an unbounded read.
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) throw new MediaLoadError("too_big");

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    throw new MediaLoadError("missing");
  }
  if (bytes.length === 0) throw new MediaLoadError("missing");
  if (bytes.length > MAX_MEDIA_BYTES) throw new MediaLoadError("too_big");

  const fromPath = safeName(decodeURIComponent(url.pathname), "");
  if (fromPath && path.extname(fromPath)) return { name: fromPath, bytes };

  const subtype = (res.headers.get("content-type") ?? "").split(";")[0].split("/")[1]?.toLowerCase() ?? "";
  return { name: `media.${EXT_BY_SUBTYPE[subtype] ?? "bin"}`, bytes };
}

/**
 * Turns an outgoing answer into bytes to upload.
 *
 * `mediaPath` wins over `mediaUrl`: a local file is already ours, needs no
 * network and cannot half-arrive. Throws MediaLoadError — and only that — so
 * the caller always has a reason to say out loud.
 */
export async function loadMedia(message: OutgoingMessage, fetchImpl: typeof fetch = fetch): Promise<MediaPayload> {
  if (message.mediaPath) return loadFromPath(message.mediaPath);

  const raw = message.mediaUrl;
  if (!raw) throw new MediaLoadError("unsupported");
  if (raw.startsWith("data:")) return loadFromDataUrl(raw);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaLoadError("unsupported");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new MediaLoadError("unsupported");
  return loadFromHttpUrl(url, fetchImpl);
}
