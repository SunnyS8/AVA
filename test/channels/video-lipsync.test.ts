import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const synthesizeSpeechMock = vi.fn();
const uploadToFalMock = vi.fn();

vi.mock("../../src/channels/telegram/voice.js", () => ({
  synthesizeSpeech: (...args: unknown[]) => synthesizeSpeechMock(...args),
  sendVoiceResponse: vi.fn(),
}));

vi.mock("../../src/core/fal-upload.js", () => ({
  uploadToFal: (...args: unknown[]) => uploadToFalMock(...args),
}));

const { generateLipSync } = await import("../../src/channels/telegram/video.js");

const OMNIHUMAN = "fal-ai/bytedance/omnihuman";
const KLING = "fal-ai/kling-video/ai-avatar/v2/standard";
const FAL_KEY = "fal-secret-key-abcdef";

/** Minimal CBR MPEG-1 Layer III stream: 128 kbps, 44.1 kHz — size fixes duration. */
function mp3OfSeconds(seconds: number): Buffer {
  const bitrate = 128_000;
  const buf = Buffer.alloc(Math.round((seconds * bitrate) / 8));
  buf[0] = 0xff; // frame sync
  buf[1] = 0xfb; // MPEG-1, Layer III, no CRC
  buf[2] = 0x90; // bitrate index 9 (128 kbps), sample rate index 0 (44100)
  buf[3] = 0x00; // stereo
  return buf;
}

let avatarPath: string;

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

/** fetch double for the fal queue: submit -> status -> result -> video download. */
function queueFetch(videoUrl = "https://fal.media/out.mp4") {
  return vi.fn((url: unknown) => {
    const target = String(url);
    if (target.endsWith("/status")) return Promise.resolve(jsonResponse({ status: "COMPLETED" }));
    if (target.includes("/requests/")) return Promise.resolve(jsonResponse({ video: { url: videoUrl } }));
    if (target.startsWith("https://queue.fal.run/")) return Promise.resolve(jsonResponse({ request_id: "req-1" }));
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(Uint8Array.from([1, 2, 3, 4]).buffer),
    });
  });
}

/** Runs the generator under fake timers so the 5s queue polling does not stall the test. */
async function runLipSync(): Promise<Buffer | null> {
  vi.useFakeTimers();
  try {
    const pending = generateLipSync("привет", { tts_provider: "minimax" }, FAL_KEY, avatarPath);
    await vi.advanceTimersByTimeAsync(30_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

/** Model slug of the queue submit (POST) call. */
function submittedModel(mockFetch: ReturnType<typeof vi.fn>): string {
  const submit = mockFetch.mock.calls.find(
    (call) => (call[1] as { method?: string } | undefined)?.method === "POST",
  );
  expect(submit, "no submit request was made").toBeDefined();
  return String(submit![0]).replace("https://queue.fal.run/", "");
}

function submittedBody(mockFetch: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const submit = mockFetch.mock.calls.find(
    (call) => (call[1] as { method?: string } | undefined)?.method === "POST",
  );
  return JSON.parse(String((submit![1] as { body: string }).body));
}

describe("generateLipSync — model routing", () => {
  beforeEach(() => {
    avatarPath = path.join(os.tmpdir(), `betsy-avatar-test-${Date.now()}.png`);
    fs.writeFileSync(avatarPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    uploadToFalMock.mockReset();
    uploadToFalMock.mockImplementation((_buf: Buffer, filename: string) =>
      Promise.resolve(`https://fal.cdn/${filename}`),
    );
    synthesizeSpeechMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    try { fs.unlinkSync(avatarPath); } catch { /* ignore */ }
  });

  it("sends short speech to OmniHuman", async () => {
    synthesizeSpeechMock.mockResolvedValue(mp3OfSeconds(8));
    const mockFetch = queueFetch();
    vi.stubGlobal("fetch", mockFetch);

    const result = await runLipSync();

    expect(submittedModel(mockFetch)).toBe(OMNIHUMAN);
    expect(result).toBeInstanceOf(Buffer);
  });

  it("sends speech longer than 30 seconds to Kling", async () => {
    synthesizeSpeechMock.mockResolvedValue(mp3OfSeconds(45));
    const mockFetch = queueFetch();
    vi.stubGlobal("fetch", mockFetch);

    await runLipSync();

    expect(submittedModel(mockFetch)).toBe(KLING);
  });

  it("falls back to Kling when the duration cannot be detected", async () => {
    synthesizeSpeechMock.mockResolvedValue(Buffer.from("this is not decodable audio data"));
    const mockFetch = queueFetch();
    vi.stubGlobal("fetch", mockFetch);

    await runLipSync();

    expect(submittedModel(mockFetch)).toBe(KLING);
  });

  it("passes an image url and an audio url to the model", async () => {
    synthesizeSpeechMock.mockResolvedValue(mp3OfSeconds(5));
    const mockFetch = queueFetch();
    vi.stubGlobal("fetch", mockFetch);

    await runLipSync();

    const body = submittedBody(mockFetch);
    expect(body.image_url).toBe("https://fal.cdn/avatar.png");
    expect(String(body.audio_url)).toContain("https://fal.cdn/");
  });
});

describe("generateLipSync — queue flow", () => {
  beforeEach(() => {
    avatarPath = path.join(os.tmpdir(), `betsy-avatar-queue-${Date.now()}.png`);
    fs.writeFileSync(avatarPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    uploadToFalMock.mockReset();
    uploadToFalMock.mockResolvedValue("https://fal.cdn/file");
    synthesizeSpeechMock.mockReset();
    synthesizeSpeechMock.mockResolvedValue(mp3OfSeconds(6));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    try { fs.unlinkSync(avatarPath); } catch { /* ignore */ }
  });

  it("submits, polls the status and downloads the result", async () => {
    const mockFetch = queueFetch("https://fal.media/circle.mp4");
    vi.stubGlobal("fetch", mockFetch);

    const result = await runLipSync();

    const urls = mockFetch.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toBe(`https://queue.fal.run/${OMNIHUMAN}`);
    expect(urls.some((u) => u === `https://queue.fal.run/${OMNIHUMAN}/requests/req-1/status`)).toBe(true);
    expect(urls.some((u) => u === `https://queue.fal.run/${OMNIHUMAN}/requests/req-1`)).toBe(true);
    expect(urls.at(-1)).toBe("https://fal.media/circle.mp4");
    expect(result?.length).toBe(4);
  });

  it("keeps the fal key out of the request bodies", async () => {
    const mockFetch = queueFetch();
    vi.stubGlobal("fetch", mockFetch);

    await runLipSync();

    const body = String((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(body).not.toContain(FAL_KEY);
  });
});

describe("generateLipSync — honest failure", () => {
  beforeEach(() => {
    avatarPath = path.join(os.tmpdir(), `betsy-avatar-fail-${Date.now()}.png`);
    fs.writeFileSync(avatarPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    uploadToFalMock.mockReset();
    uploadToFalMock.mockResolvedValue("https://fal.cdn/file");
    synthesizeSpeechMock.mockReset();
    synthesizeSpeechMock.mockResolvedValue(mp3OfSeconds(6));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    try { fs.unlinkSync(avatarPath); } catch { /* ignore */ }
  });

  it("logs the model and the error code, never the fal key", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: false,
      status: 402,
      // fal echoes the request in some errors — the key must never reach the log
      text: () => Promise.resolve(`Payment required for key ${FAL_KEY}`),
      json: () => Promise.resolve({}),
    })));

    const result = await runLipSync();

    expect(result).toBeNull();
    const log = errors.join("\n");
    expect(log).toContain(OMNIHUMAN);
    expect(log).toContain("402");
    expect(log).not.toContain(FAL_KEY);
  });

  it("logs a reason when speech synthesis produced nothing", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    synthesizeSpeechMock.mockResolvedValue(null);
    vi.stubGlobal("fetch", queueFetch());

    const result = await runLipSync();

    expect(result).toBeNull();
    expect(errors.join("\n")).toMatch(/речь|озвуч/i);
  });

  it("logs a reason when the model reports FAILED", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    vi.stubGlobal("fetch", vi.fn((url: unknown) => {
      const target = String(url);
      if (target.endsWith("/status")) return Promise.resolve(jsonResponse({ status: "FAILED" }));
      return Promise.resolve(jsonResponse({ request_id: "req-9" }));
    }));

    const result = await runLipSync();

    expect(result).toBeNull();
    expect(errors.join("\n")).toContain(OMNIHUMAN);
  });
});
