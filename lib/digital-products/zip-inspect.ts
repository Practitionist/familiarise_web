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
  | "SYMLINK_ENTRY"
  | "NESTED_ARCHIVE"
  | "EXECUTABLE_ENTRY";

export type ZipInspection =
  | { ok: true; entries: number; totalUncompressedBytes: number }
  | { ok: false; problem: ZipProblem; detail?: string };

export interface ZipInspectOptions {
  /** Refuse nested archives and executable or script entries (plain ZIP products). */
  checkEntryTypes: boolean;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
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
    detail?: string,
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
  const onDisk = u64(record, 24);
  const entries = u64(record, 32);
  if (onDisk !== entries) {
    throw new ZipFault("ZIP64_INCONSISTENT", "entry counts disagree");
  }
  return {
    entries,
    size: u64(record, 40),
    offset: u64(record, 48),
    endBound: recordAt,
  };
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
  const eocd = view(tail.subarray(at));
  const disk = eocd.getUint16(4, true);
  const cdDisk = eocd.getUint16(6, true);
  const onDisk = eocd.getUint16(8, true);
  const entries = eocd.getUint16(10, true);
  const size = eocd.getUint32(12, true);
  const offset = eocd.getUint32(16, true);
  const eocdAt = tailStart + at;
  const usesZip64 =
    entries === U16_MAX || size === U32_MAX || offset === U32_MAX;
  if (usesZip64) return readZip64Directory(read, eocdAt, fileSize);
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

interface Zip64Sizes {
  uncompressed: number;
  compressed: number;
  localOffset: number;
}

/** Resolve 0xFFFFFFFF sentinels from the entry's Zip64 extra field (0x0001). */
function zip64Sizes(
  extra: DataView,
  sentinel: { uncompressed: boolean; compressed: boolean; offset: boolean },
  fallback: Zip64Sizes,
): Zip64Sizes {
  if (!sentinel.uncompressed && !sentinel.compressed && !sentinel.offset) {
    return fallback;
  }
  let at = 0;
  while (at + 4 <= extra.byteLength) {
    const id = extra.getUint16(at, true);
    const len = extra.getUint16(at + 2, true);
    if (at + 4 + len > extra.byteLength) break;
    if (id === 0x0001) {
      let cursor = at + 4;
      const next = () => {
        if (cursor + 8 > at + 4 + len) {
          throw new ZipFault("ZIP64_INCONSISTENT", "short Zip64 extra");
        }
        const value = u64(extra, cursor);
        cursor += 8;
        return value;
      };
      const uncompressed = sentinel.uncompressed
        ? next()
        : fallback.uncompressed;
      const compressed = sentinel.compressed ? next() : fallback.compressed;
      const localOffset = sentinel.offset ? next() : fallback.localOffset;
      return { uncompressed, compressed, localOffset };
    }
    at += 4 + len;
  }
  throw new ZipFault("ZIP64_INCONSISTENT", "missing Zip64 extra");
}

/** Parse and police every central-directory record; pure over the directory bytes. */
export function inspectCentralDirectory(
  cd: Uint8Array,
  dir: { entries: number; offset: number },
  options: ZipInspectOptions,
): ZipInspection {
  try {
    const dv = view(cd);
    let at = 0;
    let total = 0;
    for (let i = 0; i < dir.entries; i++) {
      if (
        at + 46 > cd.length ||
        dv.getUint32(at, true) !== CENTRAL_HEADER_SIG
      ) {
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

      const name = decodeName(
        cd.subarray(at + 46, at + 46 + nameLen),
        (flags & 0x0800) !== 0,
      );
      // Bit 0 is traditional encryption, bit 6 strong encryption, method 99 AES.
      if ((flags & 0x0041) !== 0 || method === 99) {
        throw new ZipFault("ENCRYPTED_ENTRY", name);
      }
      if (isUnsafePath(name)) throw new ZipFault("UNSAFE_PATH", name);
      const unixMode = madeBy >> 8 === 3 ? externalAttrs >>> 16 : 0;
      if ((unixMode & 0o170000) === 0o120000) {
        throw new ZipFault("SYMLINK_ENTRY", name);
      }

      const sizes = zip64Sizes(
        new DataView(cd.buffer, cd.byteOffset + at + 46 + nameLen, extraLen),
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

      const isDirectory = name.endsWith("/");
      if (!isDirectory && options.checkEntryTypes) {
        const ext = extensionOf(name);
        if (NESTED_ARCHIVE_EXTENSIONS.has(ext)) {
          throw new ZipFault("NESTED_ARCHIVE", name);
        }
        if (EXECUTABLE_EXTENSIONS.has(ext)) {
          throw new ZipFault("EXECUTABLE_ENTRY", name);
        }
      }
      if (
        sizes.uncompressed >= ZIP_LIMITS.ratioFloorBytes &&
        sizes.uncompressed >
          Math.max(sizes.compressed, 1) * ZIP_LIMITS.maxEntryRatio
      ) {
        throw new ZipFault("COMPRESSION_RATIO", name);
      }
      total += sizes.uncompressed;
      if (total > ZIP_LIMITS.maxTotalUncompressedBytes) {
        throw new ZipFault("TOO_LARGE_UNCOMPRESSED");
      }
      at = end;
    }
    if (at !== cd.length) throw new ZipFault("CENTRAL_DIRECTORY_CORRUPT");
    return { ok: true, entries: dir.entries, totalUncompressedBytes: total };
  } catch (error) {
    if (error instanceof ZipFault) {
      return { ok: false, problem: error.problem, detail: error.message };
    }
    throw error;
  }
}

/**
 * Inspect an archive through range reads only: the EOCD (and Zip64 records)
 * from the tail, then the central directory. Entry data is never read.
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
      return { ok: false, problem: error.problem, detail: error.message };
    }
    throw error;
  }
  if (dir.entries > ZIP_LIMITS.maxEntries) {
    return { ok: false, problem: "TOO_MANY_ENTRIES" };
  }
  if (
    dir.offset + dir.size > dir.endBound ||
    dir.size > ZIP_LIMITS.maxCentralDirectoryBytes ||
    (dir.entries > 0 && dir.size < 46 * dir.entries)
  ) {
    return {
      ok: false,
      problem:
        dir.size > ZIP_LIMITS.maxCentralDirectoryBytes
          ? "TOO_MANY_ENTRIES"
          : "CENTRAL_DIRECTORY_CORRUPT",
    };
  }
  if (dir.entries === 0) {
    return { ok: true, entries: 0, totalUncompressedBytes: 0 };
  }
  const cd = await read(dir.offset, dir.offset + dir.size - 1);
  if (cd.length !== dir.size) {
    return { ok: false, problem: "CENTRAL_DIRECTORY_CORRUPT" };
  }
  return inspectCentralDirectory(cd, dir, options);
}
