import { describe, it, expect } from "vitest";
import { estimateAudioDurationSeconds } from "../../src/core/audio-duration.js";

/** Ogg Opus: an identification page plus a last page carrying the granule position. */
function oggOpus(seconds: number, preSkip = 312): Buffer {
  const idPayload = Buffer.alloc(19);
  idPayload.write("OpusHead", 0, "latin1");
  idPayload[8] = 1; // version
  idPayload[9] = 1; // channels
  idPayload.writeUInt16LE(preSkip, 10);
  idPayload.writeUInt32LE(48000, 12); // original input rate
  idPayload.writeUInt16LE(0, 16); // output gain
  idPayload[18] = 0; // mapping family

  const page = (granule: bigint, payload: Buffer, seq: number): Buffer => {
    const header = Buffer.alloc(28);
    header.write("OggS", 0, "latin1");
    header[4] = 0; // stream structure version
    header[5] = seq === 0 ? 0x02 : 0x04;
    header.writeBigUInt64LE(granule, 6);
    header.writeUInt32LE(1, 14); // serial
    header.writeUInt32LE(seq, 18);
    header.writeUInt32LE(0, 22); // checksum (not validated here)
    header[26] = 1; // one segment
    header[27] = payload.length;
    return Buffer.concat([header, payload]);
  };

  const granule = BigInt(Math.round(seconds * 48000) + preSkip);
  return Buffer.concat([
    page(0n, idPayload, 0),
    page(granule, Buffer.alloc(8, 0x11), 1),
  ]);
}

/** 16-bit mono PCM WAV at 16 kHz. */
function wav(seconds: number): Buffer {
  const sampleRate = 16000;
  const byteRate = sampleRate * 2;
  const dataSize = Math.round(seconds * byteRate);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "latin1");
  buf.write("fmt ", 12, "latin1");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

/** CBR MPEG-1 Layer III at 128 kbps — the size alone fixes the duration. */
function mp3(seconds: number): Buffer {
  const buf = Buffer.alloc(Math.round((seconds * 128_000) / 8));
  buf[0] = 0xff;
  buf[1] = 0xfb;
  buf[2] = 0x90;
  buf[3] = 0x00;
  return buf;
}

describe("estimateAudioDurationSeconds", () => {
  it("reads Ogg Opus from the granule position", () => {
    expect(estimateAudioDurationSeconds(oggOpus(12.5))).toBeCloseTo(12.5, 3);
  });

  it("reads long Ogg Opus past the 30 second mark", () => {
    expect(estimateAudioDurationSeconds(oggOpus(47))).toBeCloseTo(47, 3);
  });

  it("reads WAV from the fmt byte rate and the data size", () => {
    expect(estimateAudioDurationSeconds(wav(3.5))).toBeCloseTo(3.5, 3);
  });

  it("reads CBR MP3 from its frame header", () => {
    expect(estimateAudioDurationSeconds(mp3(9))).toBeCloseTo(9, 2);
  });

  it("skips an ID3v2 tag before the first frame", () => {
    const tag = Buffer.alloc(10 + 100);
    tag.write("ID3", 0, "latin1");
    tag[9] = 100; // syncsafe tag size
    const withTag = Buffer.concat([tag, mp3(6)]);
    expect(estimateAudioDurationSeconds(withTag)).toBeCloseTo(6, 1);
  });

  it("returns null for unrecognised data", () => {
    expect(estimateAudioDurationSeconds(Buffer.from("definitely not an audio file"))).toBeNull();
  });

  it("returns null for empty or missing buffers", () => {
    expect(estimateAudioDurationSeconds(Buffer.alloc(0))).toBeNull();
    expect(estimateAudioDurationSeconds(null)).toBeNull();
  });
});
