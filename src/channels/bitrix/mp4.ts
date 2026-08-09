/**
 * Moving an MP4's index to the front — what ffmpeg calls `-movflags +faststart`.
 *
 * An MP4 keeps its media in `mdat` and its index — track tables, durations,
 * frame sizes and the chunk offsets that address `mdat` — in `moov`. Nothing in
 * the format says which comes first, and an encoder that writes the media as it
 * goes can only write `moov` at the end, once it knows the totals. Every video
 * fal.ai hands us is built that way (measured on the live file 09.08.2026:
 * `ftyp free mdat moov`).
 *
 * A player that meets such a file cannot say a word about it until it has the
 * tail: no duration, no dimensions, no first frame. Bitrix's own chat renders a
 * video it has no preview for through a plain `<video preload="metadata">`
 * (read from the portal's `im.v2.component.sidebar` bundle, 09.08.2026), and
 * that is exactly the element such a file starves. With `moov` in front the
 * metadata arrives in the first kilobytes and playback can start on the way.
 *
 * The rewrite is byte-for-byte lossless: the same boxes in a different order,
 * with the chunk-offset tables corrected by how far `mdat` moved. Anything this
 * module does not fully understand it returns untouched — a video that is
 * merely slow to start beats a video that is corrupt.
 */

/** Boxes that hold other boxes and so must be walked into, not skipped. */
const CONTAINER_BOXES = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "udta",
  "mvex",
]);

/** Boxes whose payload is media data addressed by the chunk-offset tables. */
const MEDIA_BOXES = new Set(["mdat", "free", "skip", "wide"]);

const HEADER_BYTES = 8;
/** A `stco`/`co64` payload starts with version+flags and an entry count. */
const TABLE_PREFIX_BYTES = 8;

interface Box {
  type: string;
  start: number;
  size: number;
  /** Bytes before the payload: 8 normally, 16 for the 64-bit size form. */
  header: number;
}

/**
 * Splits a buffer into the boxes at one level.
 *
 * Returns null on anything malformed — a size that cannot hold its own header,
 * a box running past the end, trailing bytes that are not a box. Callers treat
 * null as "leave this file alone", which is why every check here is a refusal
 * rather than a repair.
 */
function readBoxes(buf: Buffer, start: number, end: number): Box[] | null {
  const boxes: Box[] = [];
  let off = start;

  while (off < end) {
    if (off + HEADER_BYTES > end) return null;

    let size = buf.readUInt32BE(off);
    let header = HEADER_BYTES;
    const type = buf.toString("latin1", off + 4, off + 8);

    if (size === 1) {
      // 64-bit size: the real length follows the type field.
      if (off + 16 > end) return null;
      const large = buf.readBigUInt64BE(off + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      // "to the end of the file" — only meaningful for the last box.
      size = end - off;
    }

    if (size < header || off + size > end) return null;
    boxes.push({ type, start: off, size, header });
    off += size;
  }

  return boxes.length > 0 ? boxes : null;
}

/** Is this an MP4/QuickTime file at all? Everything else is none of our business. */
function looksLikeMp4(buf: Buffer): boolean {
  if (buf.length < HEADER_BYTES + 4) return false;
  const type = buf.toString("latin1", 4, 8);
  return type === "ftyp" || type === "moov" || type === "mdat" || type === "free" || type === "skip";
}

/**
 * Adds `delta` to every chunk offset inside a `moov` buffer.
 *
 * Returns false if any table is malformed — a count that overruns the box, a
 * 32-bit offset that would wrap past 4 GiB. A half-patched index points at the
 * wrong bytes, which is worse than not patching at all, so the caller throws
 * the whole rewrite away on false.
 */
function shiftChunkOffsets(moov: Buffer, delta: number): boolean {
  const walk = (start: number, end: number): boolean => {
    const boxes = readBoxes(moov, start, end);
    if (!boxes) return false;

    for (const box of boxes) {
      const bodyStart = box.start + box.header;
      const bodyEnd = box.start + box.size;

      if (CONTAINER_BOXES.has(box.type)) {
        if (!walk(bodyStart, bodyEnd)) return false;
        continue;
      }

      const wide = box.type === "co64";
      if (box.type !== "stco" && !wide) continue;

      if (bodyStart + TABLE_PREFIX_BYTES > bodyEnd) return false;
      const count = moov.readUInt32BE(bodyStart + 4);
      const entry = wide ? 8 : 4;
      if (bodyStart + TABLE_PREFIX_BYTES + count * entry > bodyEnd) return false;

      for (let i = 0; i < count; i++) {
        const at = bodyStart + TABLE_PREFIX_BYTES + i * entry;
        if (wide) {
          const moved = moov.readBigUInt64BE(at) + BigInt(delta);
          if (moved > BigInt(Number.MAX_SAFE_INTEGER)) return false;
          moov.writeBigUInt64BE(moved, at);
        } else {
          const moved = moov.readUInt32BE(at) + delta;
          // Past 4 GiB a 32-bit table cannot hold the answer; only a rebuild
          // into co64 would, and that is not what this module is for.
          if (moved > 0xffff_ffff) return false;
          moov.writeUInt32BE(moved, at);
        }
      }
    }

    return true;
  };

  return walk(0, moov.length);
}

/** Does this file already carry its index ahead of its media? */
export function isFaststart(bytes: Buffer): boolean {
  if (!looksLikeMp4(bytes)) return false;
  const boxes = readBoxes(bytes, 0, bytes.length);
  if (!boxes) return false;

  const moov = boxes.findIndex((b) => b.type === "moov");
  const mdat = boxes.findIndex((b) => b.type === "mdat");
  if (moov < 0 || mdat < 0) return false;
  return moov < mdat;
}

/**
 * Returns the same movie with `moov` moved in front of the media.
 *
 * Returns the input buffer itself — same object, so callers can check identity
 * — when there is nothing to do or nothing safe to do: not an MP4, already
 * faststart, no `moov`/`mdat` pair, unparsable boxes, or an offset table that
 * cannot be corrected.
 */
export function faststart(bytes: Buffer): Buffer {
  if (!looksLikeMp4(bytes)) return bytes;

  const boxes = readBoxes(bytes, 0, bytes.length);
  if (!boxes) return bytes;

  const moovIndex = boxes.findIndex((b) => b.type === "moov");
  const mdatIndex = boxes.findIndex((b) => b.type === "mdat");
  if (moovIndex < 0 || mdatIndex < 0 || moovIndex < mdatIndex) return bytes;

  const moovBox = boxes[moovIndex];
  const moov = Buffer.from(bytes.subarray(moovBox.start, moovBox.start + moovBox.size));

  // Everything the offsets address that sits before `moov` gets pushed back by
  // exactly the size of the box we move ahead of it.
  if (!shiftChunkOffsets(moov, moovBox.size)) return bytes;

  const rest = boxes.filter((_, i) => i !== moovIndex);

  // `moov` goes after the leading header boxes and before the first box that
  // carries addressed data — putting it ahead of `ftyp` would break players
  // that expect the brand first, and the delta above assumes it lands there.
  let insertAt = rest.findIndex((b) => MEDIA_BOXES.has(b.type));
  if (insertAt < 0) insertAt = rest.length;

  const slice = (b: Box) => bytes.subarray(b.start, b.start + b.size);
  const out = Buffer.concat([
    ...rest.slice(0, insertAt).map(slice),
    moov,
    ...rest.slice(insertAt).map(slice),
  ]);

  // A rewrite that changed the length lost or invented data; refuse it.
  return out.length === bytes.length ? out : bytes;
}
