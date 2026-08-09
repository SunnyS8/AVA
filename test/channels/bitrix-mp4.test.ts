import { describe, it, expect } from "vitest";
import { faststart, isFaststart } from "../../src/channels/bitrix/mp4.js";

/** One MP4 box: 4-byte size, 4-byte type, payload. */
function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
}

/** An `stco` box (version+flags, count, then 32-bit chunk offsets). */
function stco(offsets: number[]): Buffer {
  const body = Buffer.alloc(8 + offsets.length * 4);
  body.writeUInt32BE(0, 0);
  body.writeUInt32BE(offsets.length, 4);
  offsets.forEach((o, i) => body.writeUInt32BE(o, 8 + i * 4));
  return box("stco", body);
}

/** A `co64` box — the same table with 64-bit offsets. */
function co64(offsets: number[]): Buffer {
  const body = Buffer.alloc(8 + offsets.length * 8);
  body.writeUInt32BE(0, 0);
  body.writeUInt32BE(offsets.length, 4);
  offsets.forEach((o, i) => body.writeBigUInt64BE(BigInt(o), 8 + i * 8));
  return box("co64", body);
}

/** moov wrapping the chunk table at the nesting depth a real file uses. */
function moov(table: Buffer): Buffer {
  return box("moov", box("trak", box("mdia", box("minf", box("stbl", table)))));
}

const FTYP = box("ftyp", Buffer.from("isomiso2avc1mp41", "latin1"));

/**
 * A file laid out the way our generator emits it: header, media, index last.
 * The chunk offsets are the real positions of `mdat`'s payload, so a correct
 * rewrite can be checked by reading the bytes back at the patched offsets.
 */
function movieWithMoovLast(chunks: Buffer[], table: (offsets: number[]) => Buffer = stco) {
  const mdatPayload = Buffer.concat(chunks);
  const mdat = box("mdat", mdatPayload);
  const mdatDataStart = FTYP.length + 8;

  const offsets: number[] = [];
  let at = mdatDataStart;
  for (const c of chunks) {
    offsets.push(at);
    at += c.length;
  }

  return { bytes: Buffer.concat([FTYP, mdat, moov(table(offsets))]), offsets, chunks };
}

/** Top-level box types, in file order. */
function boxOrder(buf: Buffer): string[] {
  const out: string[] = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off);
    out.push(buf.toString("latin1", off + 4, off + 8));
    if (size < 8) break;
    off += size;
  }
  return out;
}

/** Reads the chunk-offset table back out of a rewritten file. */
function readOffsets(buf: Buffer, kind: "stco" | "co64" = "stco"): number[] {
  const at = buf.indexOf(Buffer.from(kind, "latin1"));
  const count = buf.readUInt32BE(at + 8);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      kind === "stco"
        ? buf.readUInt32BE(at + 12 + i * 4)
        : Number(buf.readBigUInt64BE(at + 12 + i * 8)),
    );
  }
  return out;
}

describe("faststart", () => {
  it("moves moov ahead of mdat", () => {
    const { bytes } = movieWithMoovLast([Buffer.from("first-chunk"), Buffer.from("second")]);
    expect(boxOrder(bytes)).toEqual(["ftyp", "mdat", "moov"]);

    const out = faststart(bytes);
    expect(boxOrder(out)).toEqual(["ftyp", "moov", "mdat"]);
  });

  it("keeps every chunk offset pointing at the same bytes", () => {
    const { bytes, chunks, offsets } = movieWithMoovLast([
      Buffer.from("alpha"),
      Buffer.from("bravo-bravo"),
      Buffer.from("charlie"),
    ]);

    const out = faststart(bytes);
    const moved = readOffsets(out);

    // Every offset must have grown by exactly the size of the box that jumped
    // ahead of the media — an untouched table would still read correctly out of
    // the ORIGINAL file, so resolving the bytes alone proves nothing.
    const moovSize = out.readUInt32BE(out.indexOf(Buffer.from("moov", "latin1")) - 4);
    expect(moved).toEqual(offsets.map((o) => o + moovSize));

    moved.forEach((offset, i) => {
      const expected = chunks[i];
      expect(out.subarray(offset, offset + expected.length).toString()).toBe(expected.toString());
    });
  });

  it("patches 64-bit offset tables too", () => {
    const { bytes, chunks, offsets } = movieWithMoovLast(
      [Buffer.from("wide-one"), Buffer.from("wide-two")],
      co64,
    );

    const out = faststart(bytes);
    const moved = readOffsets(out, "co64");

    const moovSize = out.readUInt32BE(out.indexOf(Buffer.from("moov", "latin1")) - 4);
    expect(moved).toEqual(offsets.map((o) => o + moovSize));

    moved.forEach((offset, i) => {
      expect(out.subarray(offset, offset + chunks[i].length).toString()).toBe(chunks[i].toString());
    });
  });

  it("loses no bytes", () => {
    const { bytes } = movieWithMoovLast([Buffer.from("keep-every-byte")]);
    expect(faststart(bytes).length).toBe(bytes.length);
  });

  it("leaves an already-faststart file alone", () => {
    const already = Buffer.concat([FTYP, moov(stco([100])), box("mdat", Buffer.from("data"))]);
    expect(faststart(already)).toBe(already);
    expect(isFaststart(already)).toBe(true);
  });

  it("reports a moov-last file as not faststart", () => {
    const { bytes } = movieWithMoovLast([Buffer.from("x")]);
    expect(isFaststart(bytes)).toBe(false);
  });

  it("returns non-MP4 bytes untouched", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    expect(faststart(png)).toBe(png);
  });

  it("returns a truncated file untouched instead of throwing", () => {
    const { bytes } = movieWithMoovLast([Buffer.from("some-media-data")]);
    const cut = bytes.subarray(0, bytes.length - 12);
    expect(() => faststart(cut)).not.toThrow();
    expect(faststart(cut)).toBe(cut);
  });

  it("returns a file with a lying box size untouched", () => {
    const { bytes } = movieWithMoovLast([Buffer.from("media")]);
    const broken = Buffer.from(bytes);
    broken.writeUInt32BE(3, 0); // ftyp claims a size smaller than its own header
    expect(faststart(broken)).toBe(broken);
  });

  it("survives a chunk table that claims more entries than it holds", () => {
    const { bytes } = movieWithMoovLast([Buffer.from("media")]);
    const broken = Buffer.from(bytes);
    const at = broken.indexOf(Buffer.from("stco", "latin1"));
    broken.writeUInt32BE(9999, at + 8);
    expect(() => faststart(broken)).not.toThrow();
    expect(faststart(broken)).toBe(broken);
  });

  it("handles an empty buffer", () => {
    const empty = Buffer.alloc(0);
    expect(faststart(empty)).toBe(empty);
    expect(isFaststart(empty)).toBe(false);
  });
});
