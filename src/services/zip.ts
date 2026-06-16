/**
 * Minimal, dependency-free ZIP reader. Enough to read a Micro.blog "Blog
 * Archive Format" export (Markdown files + an uploads/ folder). Uses the central
 * directory (so it's robust against streaming data descriptors) and Node's
 * zlib for the single common compression method (deflate); stored entries are
 * copied verbatim. Other methods are skipped.
 */
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

const SIG_EOCD = 0x06054b50; // End of central directory
const SIG_CDH = 0x02014b50; // Central directory file header

export function unzip(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Find the End Of Central Directory record by scanning backwards (it sits in
  // the last 22 bytes + optional comment, so cap the search).
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");

  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries: ZipEntry[] = [];

  let p = cdOffset;
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (dv.getUint32(p, true) !== SIG_CDH) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    const next = p + 46 + nameLen + extraLen + commentLen;

    // Directory entries end with "/" — skip them.
    if (!name.endsWith("/")) {
      // The local header's name/extra lengths can differ from the central one.
      const lhNameLen = dv.getUint16(localOffset + 26, true);
      const lhExtraLen = dv.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      try {
        if (method === 0) entries.push({ path: name, data: comp });
        else if (method === 8) entries.push({ path: name, data: new Uint8Array(inflateRawSync(comp)) });
        // else: unsupported method (e.g. bzip2) — skip silently.
      } catch {
        // Corrupt/unsupported entry — skip rather than fail the whole import.
      }
    }
    p = next;
  }
  return entries;
}
