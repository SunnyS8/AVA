/**
 * Best-effort audio duration detection, without shelling out to ffmpeg.
 *
 * The lip-sync pipeline picks its video model by speech length, so it needs
 * seconds from a buffer it just synthesized. The containers that can actually
 * come out of `synthesizeSpeech` are parsed exactly (Ogg/Opus from OpenAI TTS,
 * MP3 from MiniMax); WAV and MP4/M4A are covered as well.
 *
 * Anything unrecognised yields `null` — the caller then picks the model that has
 * no duration cap, which is the safe direction in which to be wrong.
 */

/** Bitrate tables in kbps, indexed by the 4-bit bitrate index of the frame header. */
const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

/** Sample rates by MPEG version bits (3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5). */
const MP3_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/** Opus granule positions are always counted at 48 kHz, whatever the input rate. */
const OPUS_GRANULE_RATE = 48000;

/** How far into an MP3 stream we look for the first valid frame header. */
const MP3_SCAN_WINDOW = 16384;

/**
 * Duration of an audio buffer in seconds, or `null` when it cannot be read
 * confidently. Never throws — a malformed buffer is just an unknown duration.
 */
export function estimateAudioDurationSeconds(buffer: Buffer | null | undefined): number | null {
  if (!buffer || buffer.length < 16) return null;

  try {
    const seconds =
      oggDuration(buffer) ?? wavDuration(buffer) ?? mp4Duration(buffer) ?? mp3Duration(buffer);
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
    return seconds;
  } catch {
    return null;
  }
}

/** Ogg (Opus or Vorbis): the granule position of the last page counts samples. */
function oggDuration(buf: Buffer): number | null {
  if (buf.subarray(0, 4).toString("latin1") !== "OggS") return null;

  const lastPage = buf.lastIndexOf("OggS", buf.length, "latin1");
  if (lastPage < 0 || lastPage + 14 > buf.length) return null;

  const granule = Number(buf.readBigUInt64LE(lastPage + 6));
  if (!Number.isFinite(granule) || granule <= 0) return null;

  const opusHead = buf.indexOf("OpusHead", 0, "latin1");
  if (opusHead >= 0 && opusHead + 12 <= buf.length) {
    // OpusHead: magic(8) version(1) channels(1) pre-skip(2) — pre-skip is not audible
    const preSkip = buf.readUInt16LE(opusHead + 10);
    const samples = granule - preSkip;
    return samples > 0 ? samples / OPUS_GRANULE_RATE : null;
  }

  const vorbis = buf.indexOf("vorbis", 0, "latin1");
  if (vorbis >= 0 && vorbis + 15 <= buf.length) {
    // Identification header: "vorbis" version(4) channels(1) sample_rate(4)
    const rate = buf.readUInt32LE(vorbis + 11);
    return rate > 0 ? granule / rate : null;
  }

  return null;
}

/** RIFF/WAVE: data chunk size divided by the byte rate from the fmt chunk. */
function wavDuration(buf: Buffer): number | null {
  if (buf.subarray(0, 4).toString("latin1") !== "RIFF") return null;
  if (buf.subarray(8, 12).toString("latin1") !== "WAVE") return null;

  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.subarray(offset, offset + 4).toString("latin1");
    const size = buf.readUInt32LE(offset + 4);

    if (id === "fmt " && offset + 20 <= buf.length) {
      // fmt data: format(2) channels(2) sample_rate(4) byte_rate(4) ...
      byteRate = buf.readUInt32LE(offset + 16);
    }
    if (id === "data" && byteRate > 0) {
      return size / byteRate;
    }

    if (size <= 0) break;
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

/** MP4/M4A: the movie header box carries a timescale and a duration. */
function mp4Duration(buf: Buffer): number | null {
  if (buf.subarray(4, 8).toString("latin1") !== "ftyp") return null;

  const mvhd = buf.indexOf("mvhd", 0, "latin1");
  if (mvhd < 0) return null;

  const version = buf[mvhd + 4];
  if (version === 0 && mvhd + 24 <= buf.length) {
    // version(1) flags(3) created(4) modified(4) timescale(4) duration(4)
    const timescale = buf.readUInt32BE(mvhd + 16);
    const duration = buf.readUInt32BE(mvhd + 20);
    return timescale > 0 ? duration / timescale : null;
  }
  if (version === 1 && mvhd + 36 <= buf.length) {
    // 64-bit variant: created(8) modified(8) timescale(4) duration(8)
    const timescale = buf.readUInt32BE(mvhd + 24);
    const duration = Number(buf.readBigUInt64BE(mvhd + 28));
    return timescale > 0 ? duration / timescale : null;
  }
  return null;
}

interface Mp3Header {
  bitrate: number;
  sampleRate: number;
  samplesPerFrame: number;
  isMpeg1: boolean;
  isMono: boolean;
}

/** MPEG audio: exact frame count from a VBR header, otherwise a CBR size estimate. */
function mp3Duration(buf: Buffer): number | null {
  let start = 0;
  if (buf.subarray(0, 3).toString("latin1") === "ID3" && buf.length > 10) {
    // ID3v2 size is stored as four syncsafe bytes (7 significant bits each)
    const tagSize =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + tagSize;
  }

  const limit = Math.min(buf.length - 4, start + MP3_SCAN_WINDOW);
  for (let i = start; i <= limit; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;

    const header = parseMp3Header(buf, i);
    if (!header) continue;

    const frames = vbrFrameCount(buf, i, header);
    if (frames !== null && frames > 0) {
      return (frames * header.samplesPerFrame) / header.sampleRate;
    }
    return ((buf.length - i) * 8) / header.bitrate;
  }
  return null;
}

function parseMp3Header(buf: Buffer, i: number): Mp3Header | null {
  const versionBits = (buf[i + 1] >> 3) & 0x03; // 1 is reserved
  const layerBits = (buf[i + 1] >> 1) & 0x03; // 1 = Layer III
  if (versionBits === 1 || layerBits !== 1) return null;

  const bitrateIndex = (buf[i + 2] >> 4) & 0x0f;
  const rateIndex = (buf[i + 2] >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;

  const isMpeg1 = versionBits === 3;
  const bitrateKbps = (isMpeg1 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[bitrateIndex];
  const sampleRate = MP3_SAMPLE_RATES[versionBits]?.[rateIndex];
  if (!bitrateKbps || !sampleRate) return null;

  return {
    bitrate: bitrateKbps * 1000,
    sampleRate,
    samplesPerFrame: isMpeg1 ? 1152 : 576,
    isMpeg1,
    isMono: ((buf[i + 3] >> 6) & 0x03) === 3,
  };
}

/** Xing/Info/VBRI headers sit in the first frame and hold the total frame count. */
function vbrFrameCount(buf: Buffer, frameStart: number, header: Mp3Header): number | null {
  const sideInfo = header.isMpeg1 ? (header.isMono ? 17 : 32) : header.isMono ? 9 : 17;

  const xing = frameStart + 4 + sideInfo;
  if (xing + 12 <= buf.length) {
    const tag = buf.subarray(xing, xing + 4).toString("latin1");
    if (tag === "Xing" || tag === "Info") {
      const flags = buf.readUInt32BE(xing + 4);
      if (flags & 0x01) return buf.readUInt32BE(xing + 8);
      return null;
    }
  }

  const vbri = frameStart + 4 + 32;
  if (vbri + 20 <= buf.length && buf.subarray(vbri, vbri + 4).toString("latin1") === "VBRI") {
    return buf.readUInt32BE(vbri + 14);
  }

  return null;
}
