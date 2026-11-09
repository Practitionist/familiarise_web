import { crc32, createInflateRaw } from "node:zlib";
import { once } from "node:events";
import { ZIP_LIMITS } from "@/lib/digital-products/constants";

/** Reads bytes [start, endInclusive] of the archive. */
export type RangeReader = (
  start: number,
  endInclusive: number,
) => Promise<Uint8Array>;

export type ZipProblem =
  | "NOT_A_ZIP"
  | "EOCD_AMBIGUOUS"
  | "MULTI_DISK"
  | "ZIP64_INCONSISTENT"
  | "CENTRAL_DIRECTORY_CORRUPT"
  | "TOO_MANY_ENTRIES"
  | "TOO_LARGE_UNCOMPRESSED"
  | "COMPRESSION_RATIO"
  | "ENCRYPTED_ENTRY"
  | "UNSAFE_PATH"
  | "UNICODE_PATH_INVALID"
  | "SYMLINK_ENTRY"
  | "NESTED_ARCHIVE"
  | "EXECUTABLE_ENTRY"
  | "OFFICE_MACRO"
  | "EMBEDDED_OBJECT"
  | "LOCAL_HEADER_MISMATCH"
  | "UNLISTED_DATA"
  | "EMPTY_ARCHIVE"
  | "EMBEDDED_ZIP_RECORD"
  | "ENTRY_DATA_MISMATCH"
  | "UNVERIFIABLE_ENTRY"
  | "DEEP_SCAN_TOO_LARGE";

export type ZipInspection =
  | { ok: true; entries: number; totalUncompressedBytes: number }
  | { ok: false; problem: ZipProblem; detail?: string };

export interface ZipInspectOptions {
  /**
   * True for a plain ZIP product: refuse nested archives and executable or script entries.
   * False for a document container (OOXML, EPUB): refuse macros and embedded OLE or ActiveX objects.
   */
  checkEntryTypes: boolean;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const LOCAL_HEADER_SIG = 0x04034b50;
const LOCAL_HEADER_BYTES = 30;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
/** A data descriptor's length tells its form: 12/20 bytes unsigned, 16/24 signed, 32- or 64-bit sizes. */
const DESCRIPTOR_FORMS: ReadonlyMap<
  number,
  { signed: boolean; wide: boolean }
> = new Map([
  [12, { signed: false, wide: false }],
  [16, { signed: true, wide: false }],
  [20, { signed: false, wide: true }],
  [24, { signed: true, wide: true }],
]);
const MAX_DESCRIPTOR_BYTES = 24;
/** Flags a local header must share with its central record: encryption (0, 6), descriptor (3), UTF-8 names (11). */
const SHARED_FLAG_BITS = 0x0001 | 0x0008 | 0x0040 | 0x0800;
const STORED = 0;
const DEFLATE = 8;
/** Descriptor-sized entry data is read in pieces of this size; stored pieces overlap the last by 3 bytes. */
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
/** The third and fourth bytes after "PK" of every ZIP record signature a hidden entry needs. */
const RECORD_SIGNATURE_TAILS: ReadonlySet<number> = new Set([
  0x0304, 0x0102, 0x0708, 0x0506, 0x0606, 0x0607,
]);
/** Read past each local name: room for a Unicode Path copy of it and the usual timestamp, unix and Zip64 extras. */
const LOCAL_EXTRA_SLACK = 512;
/** Local-header reads closer than this are merged into one range read, up to LOCAL_READ_MAX bytes. */
const LOCAL_READ_GAP = 64 * 1024;
const LOCAL_READ_MAX = 1024 * 1024;
const LOCAL_READ_CONCURRENCY = 8;
const ZIP64_EXTRA_ID = 0x0001;
const UNICODE_PATH_EXTRA_ID = 0x7075;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const NESTED_ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
]);
const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe",
  "dll",
  "bat",
  "cmd",
  "sh",
  "ps1",
  "js",
  "vbs",
  "jar",
  "apk",
  "msi",
  "scr",
  "app",
  "dmg",
  "com",
  "lnk",
]);

class ZipFault extends Error {
  constructor(
    readonly problem: ZipProblem,
    readonly detail?: string,
  ) {
    super(detail ?? problem);
  }
}

function view(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** A u64 field as a safe integer; larger values cannot be a real offset or size here. */
function u64(dv: DataView, at: number): number {
  const value = dv.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipFault("ZIP64_INCONSISTENT", "64-bit field out of range");
  }
  return Number(value);
}

interface Directory {
  offset: number;
  size: number;
  entries: number;
  /** Where the record that located the directory starts; the directory must end before it. */
  endBound: number;
}

/** The only EOCD whose comment ends exactly at the end of the file; two such records are ambiguous. */
function findEocd(tail: Uint8Array): number {
  const dv = view(tail);
  let found = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) !== EOCD_SIG) continue;
    if (i + 22 + dv.getUint16(i + 20, true) !== tail.length) continue;
    if (found >= 0) throw new ZipFault("EOCD_AMBIGUOUS");
    found = i;
  }
  return found;
}

async function readZip64Directory(
  read: RangeReader,
  eocdAt: number,
  fileSize: number,
  eocd: { entries: number; size: number; offset: number },
): Promise<Directory> {
  if (eocdAt < 20) throw new ZipFault("ZIP64_INCONSISTENT", "no locator");
  const locator = view(await read(eocdAt - 20, eocdAt - 1));
  if (locator.getUint32(0, true) !== ZIP64_LOCATOR_SIG) {
    throw new ZipFault("ZIP64_INCONSISTENT", "no locator");
  }
  if (locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) !== 1) {
    throw new ZipFault("MULTI_DISK");
  }
  const recordAt = u64(locator, 8);
  if (recordAt + 56 > eocdAt - 20 || recordAt + 56 > fileSize) {
    throw new ZipFault("ZIP64_INCONSISTENT", "record outside the archive");
  }
  const record = view(await read(recordAt, recordAt + 55));
  if (record.getUint32(0, true) !== ZIP64_EOCD_SIG) {
    throw new ZipFault("ZIP64_INCONSISTENT", "bad record signature");
  }
  if (record.getUint32(16, true) !== 0 || record.getUint32(20, true) !== 0) {
    throw new ZipFault("MULTI_DISK");
  }
  // The record's own length must reach the locator exactly, leaving no room for hidden bytes.
  if (recordAt + 12 + u64(record, 4) !== eocdAt - 20) {
    throw new ZipFault("UNLISTED_DATA", "data around the Zip64 end record");
  }
  const onDisk = u64(record, 24);
  const entries = u64(record, 32);
  const size = u64(record, 40);
  const offset = u64(record, 48);
  if (onDisk !== entries) {
    throw new ZipFault("ZIP64_INCONSISTENT", "entry counts disagree");
  }
  // An EOCD field that is not a sentinel must agree, or two extractors would read two directories.
  if (
    (eocd.entries !== U16_MAX && eocd.entries !== entries) ||
    (eocd.size !== U32_MAX && eocd.size !== size) ||
    (eocd.offset !== U32_MAX && eocd.offset !== offset)
  ) {
    throw new ZipFault("ZIP64_INCONSISTENT", "EOCD and Zip64 record disagree");
  }
  return { entries, size, offset, endBound: recordAt };
}

async function locateDirectory(
  read: RangeReader,
  fileSize: number,
): Promise<Directory> {
  if (fileSize < 22) throw new ZipFault("NOT_A_ZIP");
  const tailStart = Math.max(0, fileSize - ZIP_LIMITS.eocdSearchBytes);
  const tail = await read(tailStart, fileSize - 1);
  const at = findEocd(tail);
  if (at < 0) throw new ZipFault("NOT_A_ZIP");
  // The comment ends the file, so a ZIP record inside it can only be smuggled data.
  if (findRecordSignature(tail.subarray(at + 22)) >= 0) {
    throw new ZipFault("UNLISTED_DATA", "ZIP record in the archive comment");
  }
  const eocd = view(tail.subarray(at));
  const disk = eocd.getUint16(4, true);
  const cdDisk = eocd.getUint16(6, true);
  const onDisk = eocd.getUint16(8, true);
  const entries = eocd.getUint16(10, true);
  const size = eocd.getUint32(12, true);
  const offset = eocd.getUint32(16, true);
  const eocdAt = tailStart + at;
  // Some writers add the Zip64 records even when no EOCD field overflows.
  const hasLocator =
    at >= 20 && view(tail).getUint32(at - 20, true) === ZIP64_LOCATOR_SIG;
  const usesZip64 =
    entries === U16_MAX || size === U32_MAX || offset === U32_MAX;
  if (usesZip64 || hasLocator) {
    return readZip64Directory(read, eocdAt, fileSize, {
      entries,
      size,
      offset,
    });
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== entries) {
    throw new ZipFault("MULTI_DISK");
  }
  return { entries, size, offset, endBound: eocdAt };
}

function decodeName(raw: Uint8Array, utf8: boolean): string {
  return utf8
    ? new TextDecoder("utf-8", { fatal: false }).decode(raw)
    : Array.from(raw, (b) => String.fromCharCode(b)).join("");
}

function isUnsafePath(name: string): boolean {
  if (name.includes("\0")) return true;
  if (/^[\\/]/.test(name) || /^[a-zA-Z]:/.test(name)) return true;
  return name.split(/[\\/]/).some((segment) => segment === "..");
}

/** Windows drops trailing dots and spaces on extraction, so `a.exe.` is an exe. */
function extensionOf(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[. ]+$/, "");
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

interface ExtraField {
  id: number;
  data: DataView;
}

/** Every extra field of an entry; a field that runs past the extra block is `problem`. */
function extraFields(
  extra: DataView,
  problem: ZipProblem = "CENTRAL_DIRECTORY_CORRUPT",
): ExtraField[] {
  const fields: ExtraField[] = [];
  let at = 0;
  while (at < extra.byteLength) {
    if (at + 4 > extra.byteLength) {
      throw new ZipFault(problem, "truncated extra field");
    }
    const len = extra.getUint16(at + 2, true);
    if (at + 4 + len > extra.byteLength) {
      throw new ZipFault(problem, "truncated extra field");
    }
    fields.push({
      id: extra.getUint16(at, true),
      data: new DataView(extra.buffer, extra.byteOffset + at + 4, len),
    });
    at += 4 + len;
  }
  return fields;
}

interface Zip64Sizes {
  uncompressed: number;
  compressed: number;
  localOffset: number;
}

/** Resolve 0xFFFFFFFF sentinels from the entry's Zip64 extra field (0x0001). */
function zip64Sizes(
  fields: readonly ExtraField[],
  sentinel: { uncompressed: boolean; compressed: boolean; offset: boolean },
  fallback: Zip64Sizes,
): Zip64Sizes {
  if (!sentinel.uncompressed && !sentinel.compressed && !sentinel.offset) {
    return fallback;
  }
  const field = fields.find((f) => f.id === ZIP64_EXTRA_ID);
  if (!field) throw new ZipFault("ZIP64_INCONSISTENT", "missing Zip64 extra");
  let cursor = 0;
  const next = () => {
    if (cursor + 8 > field.data.byteLength) {
      throw new ZipFault("ZIP64_INCONSISTENT", "short Zip64 extra");
    }
    const value = u64(field.data, cursor);
    cursor += 8;
    return value;
  };
  const uncompressed = sentinel.uncompressed ? next() : fallback.uncompressed;
  const compressed = sentinel.compressed ? next() : fallback.compressed;
  const localOffset = sentinel.offset ? next() : fallback.localOffset;
  return { uncompressed, compressed, localOffset };
}

/**
 * The Info-ZIP Unicode Path name (0x7075), which libarchive and Info-ZIP extract
 * under instead of the legacy name; only version 1 over the legacy name's CRC32 is accepted.
 */
function unicodePath(
  fields: readonly ExtraField[],
  rawName: Uint8Array,
): string | null {
  const found = fields.filter((f) => f.id === UNICODE_PATH_EXTRA_ID);
  if (found.length === 0) return null;
  const invalid = (detail: string) =>
    new ZipFault("UNICODE_PATH_INVALID", detail);
  if (found.length > 1) throw invalid("duplicate Unicode Path field");
  const { data } = found[0];
  if (data.byteLength < 6) throw invalid("short Unicode Path field");
  if (data.getUint8(0) !== 1) throw invalid("unknown Unicode Path version");
  if (data.getUint32(1, true) !== crc32(rawName)) {
    throw invalid("Unicode Path CRC does not match the legacy name");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(data.buffer, data.byteOffset + 5, data.byteLength - 5),
    );
  } catch {
    throw invalid("Unicode Path is not UTF-8");
  }
}

/** Whether a document part is a macro project or macro sheet, which run code when the file opens. */
function isOfficeMacroPart(name: string): boolean {
  const segments = name.toLowerCase().split(/[\\/]/);
  const base = (segments.pop() ?? "").replace(/[. ]+$/, "");
  return (
    base === "vbaproject.bin" ||
    base === "vbadata.xml" ||
    segments.includes("macrosheets")
  );
}

/** Whether a document part is an OLE or ActiveX binary, which an embedded object opens as a program. */
function isEmbeddedObjectPart(name: string): boolean {
  const segments = name.toLowerCase().split(/[\\/]/);
  const base = (segments.pop() ?? "").replace(/[. ]+$/, "");
  if (!base.endsWith(".bin")) return false;
  return (
    /^oleobject\d*\.bin$/.test(base) ||
    segments.includes("embeddings") ||
    segments.includes("activex")
  );
}

/** The path rules, then the entry-type rules for a plain archive or the macro and object rules for a document container, that every name an extractor may honour must pass. */
function policeNames(names: readonly string[], options: ZipInspectOptions) {
  for (const candidate of names) {
    if (isUnsafePath(candidate)) {
      throw new ZipFault("UNSAFE_PATH", candidate);
    }
  }
  for (const candidate of names) {
    if (candidate.endsWith("/")) continue;
    if (!options.checkEntryTypes) {
      if (isOfficeMacroPart(candidate)) {
        throw new ZipFault("OFFICE_MACRO", candidate);
      }
      if (isEmbeddedObjectPart(candidate)) {
        throw new ZipFault("EMBEDDED_OBJECT", candidate);
      }
      continue;
    }
    const ext = extensionOf(candidate);
    if (NESTED_ARCHIVE_EXTENSIONS.has(ext)) {
      throw new ZipFault("NESTED_ARCHIVE", candidate);
    }
    if (EXECUTABLE_EXTENSIONS.has(ext)) {
      throw new ZipFault("EXECUTABLE_ENTRY", candidate);
    }
  }
}

interface CentralEntry {
  name: string;
  rawName: Uint8Array;
  localOffset: number;
  /** Bit 3: the CRC and sizes trail the data in a descriptor. */
  descriptor: boolean;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  uncompressed: number;
}

/** Parse and police every central-directory record; pure over the directory bytes. */
function readCentralDirectory(
  cd: Uint8Array,
  dir: { entries: number; offset: number },
  options: ZipInspectOptions,
): { total: number; entries: CentralEntry[] } {
  const dv = view(cd);
  let at = 0;
  let total = 0;
  const entries: CentralEntry[] = [];
  for (let i = 0; i < dir.entries; i++) {
    if (at + 46 > cd.length || dv.getUint32(at, true) !== CENTRAL_HEADER_SIG) {
      throw new ZipFault("CENTRAL_DIRECTORY_CORRUPT");
    }
    const madeBy = dv.getUint16(at + 4, true);
    const flags = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const compressed32 = dv.getUint32(at + 20, true);
    const uncompressed32 = dv.getUint32(at + 24, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const diskStart = dv.getUint16(at + 34, true);
    const externalAttrs = dv.getUint32(at + 38, true);
    const localOffset32 = dv.getUint32(at + 42, true);
    const end = at + 46 + nameLen + extraLen + commentLen;
    if (end > cd.length) throw new ZipFault("CENTRAL_DIRECTORY_CORRUPT");
    if (diskStart !== 0 && diskStart !== U16_MAX) {
      throw new ZipFault("MULTI_DISK");
    }

    const rawName = cd.subarray(at + 46, at + 46 + nameLen);
    const name = decodeName(rawName, (flags & 0x0800) !== 0);
    const fields = extraFields(
      new DataView(cd.buffer, cd.byteOffset + at + 46 + nameLen, extraLen),
    );
    // Extractors differ on which name they honour, so every name rule applies to both.
    const unicodeName = unicodePath(fields, rawName);
    const names = unicodeName === null ? [name] : [name, unicodeName];
    // Bit 0 is traditional encryption, bit 6 strong encryption, method 99 AES.
    if ((flags & 0x0041) !== 0 || method === 99) {
      throw new ZipFault("ENCRYPTED_ENTRY", name);
    }
    policeNames(names, options);
    const unixMode = madeBy >> 8 === 3 ? externalAttrs >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new ZipFault("SYMLINK_ENTRY", name);
    }

    const sizes = zip64Sizes(
      fields,
      {
        uncompressed: uncompressed32 === U32_MAX,
        compressed: compressed32 === U32_MAX,
        offset: localOffset32 === U32_MAX,
      },
      {
        uncompressed: uncompressed32,
        compressed: compressed32,
        localOffset: localOffset32,
      },
    );
    if (sizes.localOffset >= dir.offset) {
      throw new ZipFault("CENTRAL_DIRECTORY_CORRUPT", name);
    }

    if (
      sizes.uncompressed >= ZIP_LIMITS.ratioFloorBytes &&
      sizes.uncompressed >
        Math.max(sizes.compressed, 1) * ZIP_LIMITS.maxEntryRatio
    ) {
      const ratio = Math.round(
        sizes.uncompressed / Math.max(sizes.compressed, 1),
      );
      throw new ZipFault("COMPRESSION_RATIO", `${name} (${ratio}:1)`);
    }
    total += sizes.uncompressed;
    if (total > ZIP_LIMITS.maxTotalUncompressedBytes) {
      throw new ZipFault("TOO_LARGE_UNCOMPRESSED");
    }
    entries.push({
      name,
      rawName,
      localOffset: sizes.localOffset,
      descriptor: (flags & 0x0008) !== 0,
      flags,
      method,
      crc: dv.getUint32(at + 16, true),
      compressed: sizes.compressed,
      uncompressed: sizes.uncompressed,
    });
    at = end;
  }
  if (at !== cd.length) throw new ZipFault("CENTRAL_DIRECTORY_CORRUPT");
  return { total, entries };
}

interface Span {
  start: number;
  endInclusive: number;
}

interface Chunk {
  start: number;
  bytes: Uint8Array;
}

/** Merge spans into range reads: neighbours within LOCAL_READ_GAP share one read of at most LOCAL_READ_MAX bytes. */
function coalesce(spans: readonly Span[]): Span[] {
  const reads: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = reads.at(-1);
    const end = last ? Math.max(last.endInclusive, span.endInclusive) : 0;
    if (
      last &&
      span.start - last.endInclusive - 1 <= LOCAL_READ_GAP &&
      end - last.start + 1 <= LOCAL_READ_MAX
    ) {
      last.endInclusive = end;
    } else {
      reads.push({ ...span });
    }
  }
  return reads;
}

/** Read the coalesced spans, LOCAL_READ_CONCURRENCY at a time; chunks come back sorted by start. */
async function readSpans(
  read: RangeReader,
  spans: readonly Span[],
): Promise<Chunk[]> {
  const reads = coalesce(spans);
  const chunks: Chunk[] = new Array(reads.length);
  let next = 0;
  const worker = async () => {
    while (next < reads.length) {
      const i = next++;
      const { start, endInclusive } = reads[i];
      chunks[i] = { start, bytes: await read(start, endInclusive) };
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(LOCAL_READ_CONCURRENCY, reads.length) },
      worker,
    ),
  );
  return chunks;
}

/** Bytes [start, start + length) from the one chunk holding them all, or null. */
function bytesAt(
  chunks: readonly Chunk[],
  start: number,
  length: number,
): Uint8Array | null {
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (chunks[mid].start <= start) lo = mid;
    else hi = mid - 1;
  }
  const chunk = chunks[lo];
  if (!chunk || chunk.start > start) return null;
  const from = start - chunk.start;
  if (from + length > chunk.bytes.length) return null;
  return chunk.bytes.subarray(from, from + length);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The local header's CRC and sizes, its Zip64 extra (uncompressed, then compressed) resolving sentinels. */
function localSizes(
  fixed: DataView,
  fields: readonly ExtraField[],
): { crc: number; compressed: number; uncompressed: number } {
  const crc = fixed.getUint32(14, true);
  const compressed = fixed.getUint32(18, true);
  const uncompressed = fixed.getUint32(22, true);
  if (compressed !== U32_MAX && uncompressed !== U32_MAX) {
    return { crc, compressed, uncompressed };
  }
  const zip64 = fields.find((f) => f.id === ZIP64_EXTRA_ID);
  if (!zip64 || zip64.data.byteLength < 16) {
    throw new ZipFault("LOCAL_HEADER_MISMATCH", "missing local Zip64 sizes");
  }
  return {
    crc,
    uncompressed: u64(zip64.data, 0),
    compressed: u64(zip64.data, 8),
  };
}

/** A descriptor matches the central CRC and sizes; `bytes` is exactly its length. */
function descriptorMatches(bytes: Uint8Array, entry: CentralEntry): boolean {
  const form = DESCRIPTOR_FORMS.get(bytes.length);
  if (!form) return false;
  const dv = view(bytes);
  if (form.signed && dv.getUint32(0, true) !== DATA_DESCRIPTOR_SIG) {
    return false;
  }
  const at = form.signed ? 4 : 0;
  const compressed = form.wide ? u64(dv, at + 4) : dv.getUint32(at + 4, true);
  const uncompressed = form.wide
    ? u64(dv, at + 12)
    : dv.getUint32(at + 8, true);
  return (
    dv.getUint32(at, true) === entry.crc &&
    compressed === entry.compressed &&
    uncompressed === entry.uncompressed
  );
}

/**
 * Streaming extractors (libarchive, `tar -tf`) walk the local records, so the
 * listed records must tile [0, central directory) exactly: each local header
 * repeats its central name, CRC and sizes (or, with bit 3, a descriptor does),
 * and no byte is left over for an unlisted entry to hide in.
 */
async function inspectLocalHeaders(
  read: RangeReader,
  entries: readonly CentralEntry[],
  dirOffset: number,
  options: ZipInspectOptions,
): Promise<void> {
  const mismatch = (entry: CentralEntry, detail: string) =>
    new ZipFault("LOCAL_HEADER_MISMATCH", `${entry.name} (${detail})`);
  const unlisted = (detail: string) => new ZipFault("UNLISTED_DATA", detail);
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  // A descriptor-sized entry's true end is known only from its data, so it is read.
  const deep = sorted.filter((e) => e.descriptor);
  const unverifiable = deep.find(
    (e) => e.method !== STORED && e.method !== DEFLATE,
  );
  if (unverifiable) {
    throw new ZipFault(
      "UNVERIFIABLE_ENTRY",
      `${unverifiable.name} (method ${unverifiable.method})`,
    );
  }
  const deepBytes = deep.reduce((sum, e) => sum + e.compressed, 0);
  if (deepBytes > ZIP_LIMITS.maxDeepScanCompressedBytes) {
    throw new ZipFault(
      "DEEP_SCAN_TOO_LARGE",
      `${Math.ceil(deepBytes / (1024 * 1024))} MB`,
    );
  }
  const nextOffset = (i: number) =>
    i + 1 < sorted.length ? sorted[i + 1].localOffset : dirOffset;
  if (sorted[0].localOffset !== 0) {
    throw unlisted("data before the first entry");
  }
  sorted.forEach((e, i) => {
    if (nextOffset(i) - e.localOffset < LOCAL_HEADER_BYTES) {
      throw unlisted(`${e.name} overlaps the next entry`);
    }
  });
  // One over-read per header usually covers its name and extra; a descriptor
  // is read from the tail of its record, which abuts the next header's window.
  const spans: Span[] = sorted.map((e, i) => ({
    start: e.localOffset,
    endInclusive:
      Math.min(
        nextOffset(i),
        e.localOffset +
          LOCAL_HEADER_BYTES +
          2 * e.rawName.length +
          LOCAL_EXTRA_SLACK,
      ) - 1,
  }));
  sorted.forEach((e, i) => {
    const end = nextOffset(i);
    if (e.descriptor && end > e.localOffset) {
      spans.push({
        start: Math.max(e.localOffset, end - MAX_DESCRIPTOR_BYTES),
        endInclusive: end - 1,
      });
    }
  });
  const first = await readSpans(read, spans);

  const headerEnds = new Map<CentralEntry, number>();
  const tails: Array<{ entry: CentralEntry; fixed: DataView; span: Span }> = [];
  const checkTail = (
    entry: CentralEntry,
    fixed: DataView,
    tail: Uint8Array,
  ) => {
    const nameLen = entry.rawName.length;
    const localRaw = tail.subarray(0, nameLen);
    if (!sameBytes(localRaw, entry.rawName)) {
      throw mismatch(entry, "name differs");
    }
    const fields = extraFields(
      new DataView(
        tail.buffer,
        tail.byteOffset + nameLen,
        tail.byteLength - nameLen,
      ),
      "LOCAL_HEADER_MISMATCH",
    );
    const unicodeName = unicodePath(fields, localRaw);
    if (unicodeName !== null) policeNames([unicodeName], options);
    if (!entry.descriptor) {
      const local = localSizes(fixed, fields);
      if (
        local.crc !== entry.crc ||
        local.compressed !== entry.compressed ||
        local.uncompressed !== entry.uncompressed
      ) {
        throw mismatch(entry, "sizes differ");
      }
    }
  };
  sorted.forEach((entry, i) => {
    const fixed = bytesAt(first, entry.localOffset, LOCAL_HEADER_BYTES);
    if (!fixed) throw unlisted(`${entry.name} overlaps the next entry`);
    const dv = view(fixed);
    if (dv.getUint32(0, true) !== LOCAL_HEADER_SIG) {
      throw mismatch(entry, "bad signature");
    }
    if (((dv.getUint16(6, true) ^ entry.flags) & SHARED_FLAG_BITS) !== 0) {
      throw mismatch(entry, "flags differ");
    }
    // Equal methods make the stored-descriptor scan's choice hold for either header.
    if (dv.getUint16(8, true) !== entry.method) {
      throw mismatch(entry, "compression method differs");
    }
    const nameLen = dv.getUint16(26, true);
    const extraLen = dv.getUint16(28, true);
    if (nameLen !== entry.rawName.length) throw mismatch(entry, "name differs");
    const tailStart = entry.localOffset + LOCAL_HEADER_BYTES;
    const headerEnd = tailStart + nameLen + extraLen;
    if (headerEnd > nextOffset(i)) {
      throw unlisted(`${entry.name} overlaps the next entry`);
    }
    headerEnds.set(entry, headerEnd);
    const tail = bytesAt(first, tailStart, nameLen + extraLen);
    if (tail) {
      checkTail(entry, dv, tail);
    } else {
      tails.push({
        entry,
        fixed: dv,
        span: { start: tailStart, endInclusive: headerEnd - 1 },
      });
    }
  });
  if (tails.length > 0) {
    const second = await readSpans(
      read,
      tails.map((t) => t.span),
    );
    for (const { entry, fixed, span } of tails) {
      const tail = bytesAt(
        second,
        span.start,
        span.endInclusive - span.start + 1,
      );
      if (!tail) throw mismatch(entry, "header outside the archive");
      checkTail(entry, fixed, tail);
    }
  }

  // Header, data, then for bit 3 a descriptor, must reach the next record exactly.
  sorted.forEach((entry, i) => {
    const dataEnd = (headerEnds.get(entry) ?? 0) + entry.compressed;
    const gap = nextOffset(i) - dataEnd;
    if (!entry.descriptor) {
      if (gap !== 0) throw unlisted(`${gap} bytes after ${entry.name}`);
      return;
    }
    if (!DESCRIPTOR_FORMS.has(gap)) {
      throw unlisted(`${gap} bytes after ${entry.name}`);
    }
    const bytes = bytesAt(first, dataEnd, gap);
    if (!bytes || !descriptorMatches(bytes, entry)) {
      throw mismatch(entry, "data descriptor differs");
    }
  });
  await deepScan(read, deep, headerEnds);
}

/** Where "PK" plus a record signature tail first starts in `bytes`, or -1. */
function findRecordSignature(bytes: Uint8Array): number {
  for (let i = bytes.indexOf(0x50); i >= 0 && i + 3 < bytes.length;) {
    if (
      bytes[i + 1] === 0x4b &&
      RECORD_SIGNATURE_TAILS.has((bytes[i + 2] << 8) | bytes[i + 3])
    ) {
      return i;
    }
    i = bytes.indexOf(0x50, i + 1);
  }
  return -1;
}

interface Piece extends Span {
  entry: CentralEntry;
}

/**
 * Inflate one DEFLATE entry from its pieces in order: the stream must end
 * exactly at the central compressed size, with the central size and CRC.
 */
async function inflateEntry(
  entry: CentralEntry,
  parts: readonly Uint8Array[],
): Promise<ZipFault | null> {
  const inflate = createInflateRaw();
  let out = 0;
  let crc = 0;
  let oversized = false;
  let ended = false;
  let failed = false;
  inflate.on("data", (chunk: Buffer) => {
    out += chunk.length;
    crc = crc32(chunk, crc);
    // A bomb stops at the declared size, which the ratio and total limits already bound.
    if (out > entry.uncompressed) {
      oversized = true;
      inflate.destroy();
    }
  });
  const settled = new Promise<void>((resolve) => {
    inflate.once("end", () => {
      ended = true;
      resolve();
    });
    inflate.once("error", () => {
      failed = true;
      resolve();
    });
    inflate.once("close", () => resolve());
  });
  for (const part of parts) {
    if (ended || failed || oversized) break;
    if (!inflate.write(part)) {
      await Promise.race([once(inflate, "drain"), settled]);
    }
  }
  if (!inflate.destroyed) inflate.end();
  await settled;
  const mismatch = (detail: string) =>
    new ZipFault("ENTRY_DATA_MISMATCH", `${entry.name} (${detail})`);
  if (oversized) return mismatch("inflates past its declared size");
  if (failed || !ended) return mismatch("not a complete deflate stream");
  if (inflate.bytesWritten !== entry.compressed) {
    return new ZipFault(
      "UNLISTED_DATA",
      `${entry.compressed - inflate.bytesWritten} bytes after the deflate stream of ${entry.name}`,
    );
  }
  if (out !== entry.uncompressed || crc !== entry.crc) {
    return mismatch("size or CRC differs");
  }
  return null;
}

/**
 * Bit-3 entries carry their length after the data, so a streaming extractor
 * finds their end from the data itself: a stored entry must hold no ZIP
 * record signature, and a DEFLATE stream must end exactly where the central
 * directory says. The reads share one compressed-byte budget.
 */
async function deepScan(
  read: RangeReader,
  deep: readonly CentralEntry[],
  headerEnds: ReadonlyMap<CentralEntry, number>,
): Promise<void> {
  const pieces: Piece[] = [];
  for (const entry of deep) {
    const start = headerEnds.get(entry) ?? 0;
    const end = start + entry.compressed;
    const overlap = entry.method === STORED ? 3 : 0;
    for (let at = start; at < end; at += SCAN_CHUNK_BYTES) {
      pieces.push({
        entry,
        start: Math.max(start, at - overlap),
        endInclusive: Math.min(end, at + SCAN_CHUNK_BYTES) - 1,
      });
    }
  }
  const reads = coalesce(pieces);
  const chunks: Chunk[] = new Array(reads.length);
  const found: { fault: ZipFault | null } = { fault: null };
  const pieceBytes = (piece: Piece, within: readonly Chunk[]) => {
    const bytes = bytesAt(
      within,
      piece.start,
      piece.endInclusive - piece.start + 1,
    );
    if (!bytes) {
      found.fault ??= new ZipFault("UNLISTED_DATA", "archive ends early");
    }
    return bytes;
  };
  let next = 0;
  const worker = async () => {
    while (found.fault === null && next < reads.length) {
      const i = next++;
      const { start, endInclusive } = reads[i];
      const chunk = { start, bytes: await read(start, endInclusive) };
      chunks[i] = chunk;
      // Stored pieces are scanned as they land, so a hit stops further reads.
      for (const piece of pieces) {
        if (piece.entry.method !== STORED) continue;
        if (piece.start < start || piece.endInclusive > endInclusive) continue;
        const bytes = pieceBytes(piece, [chunk]);
        if (bytes && findRecordSignature(bytes) >= 0) {
          found.fault ??= new ZipFault("EMBEDDED_ZIP_RECORD", piece.entry.name);
        }
        if (found.fault) return;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(LOCAL_READ_CONCURRENCY, reads.length) },
      worker,
    ),
  );
  if (found.fault) throw found.fault;
  for (const entry of deep) {
    if (entry.method !== DEFLATE) continue;
    const parts: Uint8Array[] = [];
    for (const piece of pieces) {
      if (piece.entry !== entry) continue;
      const bytes = pieceBytes(piece, chunks);
      if (!bytes) throw found.fault ?? new ZipFault("UNLISTED_DATA");
      parts.push(bytes);
    }
    const fault = await inflateEntry(entry, parts);
    if (fault) throw fault;
  }
}

/**
 * Inspect an archive through range reads only: the EOCD (and Zip64 records)
 * from the tail, the central directory, every local header in coalesced
 * reads, and the data of bit-3 entries only.
 */
export async function inspectZip(
  read: RangeReader,
  fileSize: number,
  options: ZipInspectOptions,
): Promise<ZipInspection> {
  let dir: Directory;
  try {
    dir = await locateDirectory(read, fileSize);
  } catch (error) {
    if (error instanceof ZipFault) {
      return { ok: false, problem: error.problem, detail: error.detail };
    }
    throw error;
  }
  // Nothing to sell, and with nothing listed no byte before the end record can be accounted for.
  if (dir.entries === 0) return { ok: false, problem: "EMPTY_ARCHIVE" };
  if (dir.entries > ZIP_LIMITS.maxEntries) {
    return { ok: false, problem: "TOO_MANY_ENTRIES" };
  }
  if (
    dir.offset + dir.size > dir.endBound ||
    dir.size > ZIP_LIMITS.maxCentralDirectoryBytes ||
    dir.size < 46 * dir.entries
  ) {
    return {
      ok: false,
      problem:
        dir.size > ZIP_LIMITS.maxCentralDirectoryBytes
          ? "TOO_MANY_ENTRIES"
          : "CENTRAL_DIRECTORY_CORRUPT",
    };
  }
  // The directory runs exactly to its end record (EOCD, or the Zip64 record before it).
  if (dir.offset + dir.size !== dir.endBound) {
    return {
      ok: false,
      problem: "UNLISTED_DATA",
      detail: "data between the central directory and its end record",
    };
  }
  const cd = await read(dir.offset, dir.offset + dir.size - 1);
  if (cd.length !== dir.size) {
    return { ok: false, problem: "CENTRAL_DIRECTORY_CORRUPT" };
  }
  try {
    const { total, entries } = readCentralDirectory(cd, dir, options);
    await inspectLocalHeaders(read, entries, dir.offset, options);
    return { ok: true, entries: dir.entries, totalUncompressedBytes: total };
  } catch (error) {
    if (error instanceof ZipFault) {
      return { ok: false, problem: error.problem, detail: error.detail };
    }
    throw error;
  }
}
