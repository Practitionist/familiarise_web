/**
 * @jest-environment node
 */
import { crc32, deflateRawSync } from "node:zlib";
import { inspectZip } from "@/lib/digital-products/zip-inspect";
import { checkFileSignature } from "@/lib/digital-products/file-signature";
import {
  ASSET_REJECT_MESSAGES,
  describeRejectReason,
  formatRejectReason,
} from "@/lib/digital-products/reject-reasons";

interface Entry {
  name: string;
  compressed?: number;
  uncompressed?: number;
  flags?: number;
  madeBy?: number;
  externalAttrs?: number;
  /** Central-directory extra field bytes. */
  extra?: Buffer;
  /** Local-header name and extra field, when they differ from the central ones. */
  localName?: string;
  localExtra?: Buffer;
  /** The compressed size the local header claims, when it lies. */
  localCompressed?: number;
  /** Sizes trail the data in a descriptor (bit 3), with or without its signature. */
  descriptor?: "signed" | "unsigned";
  /** A local record the central directory does not list. */
  hidden?: boolean;
  /** Compression method; 0 is stored. Defaults to deflate. */
  method?: number;
  /** Entry data; defaults to zero filler of the compressed size. */
  data?: Buffer;
  /** CRC-32 of the uncompressed data, written to every header that carries one. */
  crc?: number;
}

/** A real DEFLATE entry body for `text`, with its CRC and sizes. */
const deflated = (text: string) => ({
  method: 8,
  data: deflateRawSync(Buffer.from(text)),
  uncompressed: Buffer.byteLength(text),
  crc: crc32(Buffer.from(text)),
});

/** A structurally valid archive; entry data is zero filler of the compressed size. */
function buildZip(entries: Entry[], comment = Buffer.alloc(0)): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let listed = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const compressed = e.data?.length ?? e.compressed ?? 16;
    const uncompressed = e.uncompressed ?? compressed;
    const localName = Buffer.from(e.localName ?? e.name, "utf8");
    const localExtra = e.localExtra ?? Buffer.alloc(0);
    const flags = (e.flags ?? 0x0800) | (e.descriptor ? 0x0008 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(e.method ?? 8, 8);
    local.writeUInt32LE(
      e.descriptor ? 0 : (e.localCompressed ?? compressed),
      18,
    );
    local.writeUInt32LE(e.descriptor ? 0 : uncompressed, 22);
    if (!e.descriptor) local.writeUInt32LE(e.crc ?? 0, 14);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const data = e.data ?? Buffer.alloc(compressed);
    const descriptor = Buffer.alloc(
      e.descriptor === "signed" ? 16 : e.descriptor ? 12 : 0,
    );
    if (e.descriptor) {
      const at = e.descriptor === "signed" ? 4 : 0;
      if (at) descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(e.crc ?? 0, at);
      descriptor.writeUInt32LE(compressed, at + 4);
      descriptor.writeUInt32LE(uncompressed, at + 8);
    }
    locals.push(local, localName, localExtra, data, descriptor);
    const recordBytes =
      30 +
      localName.length +
      localExtra.length +
      compressed +
      descriptor.length;
    if (e.hidden) {
      offset += recordBytes;
      continue;
    }

    const extra = e.extra ?? Buffer.alloc(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.madeBy ?? 20, 4);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(e.method ?? 8, 10);
    central.writeUInt32LE(e.crc ?? 0, 16);
    central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(e.externalAttrs ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name, extra);
    listed += 1;
    offset += recordBytes;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(listed, 8);
  eocd.writeUInt16LE(listed, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, eocd, comment]);
}

function inspect(zip: Buffer, checkEntryTypes = true) {
  return inspectZip(
    async (start, end) => new Uint8Array(zip.subarray(start, end + 1)),
    zip.length,
    { checkEntryTypes },
  );
}

const MB = 1024 * 1024;

it("accepts a clean archive and rejects each unsafe shape", async () => {
  await expect(
    inspect(buildZip([{ name: "guide/intro.pdf" }, { name: "guide/" }])),
  ).resolves.toEqual({ ok: true, entries: 2, totalUncompressedBytes: 32 });

  const cases: Array<[Entry[], string]> = [
    [
      [{ name: "bomb.txt", compressed: 1024, uncompressed: 200 * MB }],
      "COMPRESSION_RATIO",
    ],
    [[{ name: "../../etc/passwd" }], "UNSAFE_PATH"],
    [[{ name: "/abs/file.txt" }], "UNSAFE_PATH"],
    [[{ name: "inner/pack.zip" }], "NESTED_ARCHIVE"],
    [[{ name: "setup.EXE" }], "EXECUTABLE_ENTRY"],
    [[{ name: "evil.exe." }], "EXECUTABLE_ENTRY"],
    [[{ name: "evil.exe " }], "EXECUTABLE_ENTRY"],
    [[{ name: "inner/pack.zip. ." }], "NESTED_ARCHIVE"],
    [[{ name: "secret.pdf", flags: 0x0801 }], "ENCRYPTED_ENTRY"],
    [
      [{ name: "link", madeBy: 0x0314, externalAttrs: 0o120777 * 0x10000 }],
      "SYMLINK_ENTRY",
    ],
    [
      Array.from({ length: 4 }, (_, i) => ({
        name: `big-${i}.bin`,
        compressed: 2 * MB,
        uncompressed: 150 * MB,
      })),
      "TOO_LARGE_UNCOMPRESSED",
    ],
  ];
  for (const [entries, problem] of cases) {
    await expect(inspect(buildZip(entries))).resolves.toMatchObject({
      ok: false,
      problem,
    });
  }

  const many = buildZip(
    Array.from({ length: 1001 }, (_, i) => ({
      name: `f${i}.txt`,
      compressed: 1,
    })),
  );
  await expect(inspect(many)).resolves.toMatchObject({
    ok: false,
    problem: "TOO_MANY_ENTRIES",
  });

  // Office containers skip the entry-type rules but keep the structural ones.
  await expect(
    inspect(buildZip([{ name: "word/vbaProject.js" }]), false),
  ).resolves.toMatchObject({ ok: true });

  // A Zip64 sentinel without its locator is inconsistent, not trusted.
  const zip64 = buildZip([{ name: "a.txt" }]);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 6);
  await expect(inspect(zip64)).resolves.toMatchObject({
    ok: false,
    problem: "ZIP64_INCONSISTENT",
  });
  await expect(
    inspect(Buffer.from("not a zip at all, sorry")),
  ).resolves.toMatchObject({
    ok: false,
    problem: "NOT_A_ZIP",
  });
});

it("reads only the EOCD whose comment ends the file, never a decoy inside it", async () => {
  await expect(
    inspect(buildZip([{ name: "guide.pdf" }], Buffer.from("Made with zip"))),
  ).resolves.toMatchObject({ ok: true, entries: 1 });

  // The comment carries a benign directory and a decoy EOCD pointing at it.
  const real = buildZip([{ name: "setup.exe" }]);
  const benign = buildZip([{ name: "guide.pdf" }]);
  const benignCd = benign.subarray(benign.length - 22 - 55, benign.length - 22);
  const decoy = Buffer.from(benign.subarray(benign.length - 22));
  decoy.writeUInt32LE(real.length, 16);
  const withDecoy = (padding: string) => {
    const comment = Buffer.concat([benignCd, decoy, Buffer.from(padding)]);
    return buildZip([{ name: "setup.exe" }], comment);
  };
  // The decoy's records in the comment are refused before anything is trusted.
  await expect(inspect(withDecoy("padding"))).resolves.toMatchObject({
    ok: false,
    problem: "UNLISTED_DATA",
  });
  // A decoy that also ends the file leaves two candidates.
  await expect(inspect(withDecoy(""))).resolves.toMatchObject({
    ok: false,
    problem: "EOCD_AMBIGUOUS",
  });
});

it("matches magic bytes to the declared type and refuses executables", () => {
  const pdf = new Uint8Array(Buffer.from("%PDF-1.7\n1 0 obj"));
  expect(checkFileSignature(pdf, "application/pdf")).toEqual({ ok: true });
  expect(checkFileSignature(pdf, "image/png")).toEqual({
    ok: false,
    problem: "SIGNATURE_MISMATCH",
  });
  expect(
    checkFileSignature(new Uint8Array(Buffer.from("MZ\x90\x00")), "text/plain"),
  ).toEqual({ ok: false, problem: "EXECUTABLE" });
  expect(
    checkFileSignature(
      new Uint8Array(Buffer.from("%PDF-1.4 /JavaScript (app.alert)")),
      "application/pdf",
    ),
  ).toEqual({ ok: false, problem: "POLYGLOT", detail: "/javascript" });
});

it("stores the matched check as CODE:detail and reads it back as one sentence", () => {
  const stored = formatRejectReason(
    "ZIP_COMPRESSION_RATIO",
    "big.bin\n(512:1)",
  );
  expect(stored).toBe("ZIP_COMPRESSION_RATIO:big.bin (512:1)");
  expect(describeRejectReason(stored)).toEqual({
    code: "ZIP_COMPRESSION_RATIO",
    detail: "big.bin (512:1)",
    message: ASSET_REJECT_MESSAGES.ZIP_COMPRESSION_RATIO,
  });
  expect(describeRejectReason("ZIP_UNICODE_PATH_INVALID")).toMatchObject({
    detail: null,
    message: expect.stringMatching(/^A file name inside/),
  });
});

/** An Info-ZIP Unicode Path extra field (0x7075) over `legacy`. */
function unicodePath(
  legacy: string,
  unicode: string,
  { version = 1, crc = crc32(Buffer.from(legacy, "utf8")) } = {},
): Buffer {
  const name = Buffer.from(unicode, "utf8");
  const field = Buffer.alloc(9);
  field.writeUInt16LE(0x7075, 0);
  field.writeUInt16LE(5 + name.length, 2);
  field.writeUInt8(version, 4);
  field.writeUInt32LE(crc, 5);
  return Buffer.concat([field, name]);
}

it("applies every name rule to the Unicode Path name as well", async () => {
  const entry = (unicode: string, opts?: { version?: number; crc?: number }) =>
    buildZip([
      {
        name: "guide.txt",
        flags: 0,
        extra: unicodePath("guide.txt", unicode, opts),
      },
    ]);
  await expect(inspect(entry("guide-é.txt"))).resolves.toMatchObject({
    ok: true,
    entries: 1,
  });
  const cases: Array<[Buffer, string]> = [
    [entry("payload.exe"), "EXECUTABLE_ENTRY"],
    [entry("../payload.txt"), "UNSAFE_PATH"],
    [entry("guide-é.txt", { crc: 0 }), "UNICODE_PATH_INVALID"],
    [entry("guide-é.txt", { version: 2 }), "UNICODE_PATH_INVALID"],
  ];
  for (const [zip, problem] of cases) {
    await expect(inspect(zip)).resolves.toMatchObject({ ok: false, problem });
  }
});

it("requires each local header to repeat its central name and polices its Unicode Path", async () => {
  await expect(
    inspect(buildZip([{ name: "notes.txt", localName: "notes.exe" }])),
  ).resolves.toMatchObject({ ok: false, problem: "LOCAL_HEADER_MISMATCH" });
  await expect(
    inspect(
      buildZip([
        {
          name: "guide.txt",
          flags: 0,
          localExtra: unicodePath("guide.txt", "payload.exe"),
        },
      ]),
    ),
  ).resolves.toMatchObject({ ok: false, problem: "EXECUTABLE_ENTRY" });
  // A local extra longer than the over-read takes a second read and still passes.
  await expect(
    inspect(
      buildZip([
        { name: "guide.txt", localExtra: Buffer.alloc(2000) },
        { name: "notes.txt" },
      ]),
    ),
  ).resolves.toMatchObject({ ok: true, entries: 2 });

  // Every byte before the central directory belongs to a listed record.
  await expect(
    inspect(
      buildZip([{ name: "notes.txt" }, { name: "payload.exe", hidden: true }]),
    ),
  ).resolves.toMatchObject({ ok: false, problem: "UNLISTED_DATA" });
  await expect(
    inspect(
      buildZip([{ name: "notes.txt", compressed: 4096, localCompressed: 16 }]),
    ),
  ).resolves.toMatchObject({ ok: false, problem: "LOCAL_HEADER_MISMATCH" });
  for (const descriptor of ["signed", "unsigned"] as const) {
    await expect(
      inspect(
        buildZip([
          { name: "a.txt", descriptor, ...deflated("alpha ".repeat(50)) },
          { name: "b.txt", descriptor, ...deflated("beta") },
        ]),
      ),
    ).resolves.toMatchObject({ ok: true, entries: 2 });
  }
  // A descriptor that disagrees with the central sizes is refused.
  const lying = buildZip([{ name: "a.txt", descriptor: "signed" }]);
  lying.writeUInt32LE(99, 30 + 5 + 16 + 8);
  await expect(inspect(lying)).resolves.toMatchObject({
    ok: false,
    problem: "LOCAL_HEADER_MISMATCH",
  });

  // 1,000 entries of 4 KiB: the tail, the central directory, then coalesced 1 MiB local reads.
  const zip = buildZip(
    Array.from({ length: 1000 }, (_, i) => ({
      name: `f${i}.txt`,
      compressed: 4096,
    })),
  );
  let reads = 0;
  const result = await inspectZip(
    async (start, end) => {
      reads += 1;
      return new Uint8Array(zip.subarray(start, end + 1));
    },
    zip.length,
    { checkEntryTypes: true },
  );
  expect(result).toMatchObject({ ok: true, entries: 1000 });
  expect(reads).toBe(6);
});

it("scans stored entries with a data descriptor for ZIP records, within a cap", async () => {
  // Python's zipfile writes these by default to an unseekable stream.
  const stored = (data: Buffer, descriptor: "signed" | "unsigned" = "signed") =>
    buildZip([{ name: "notes.txt", method: 0, descriptor, data }]);
  for (const descriptor of ["signed", "unsigned"] as const) {
    await expect(
      inspect(stored(Buffer.from("plain text, nothing hidden"), descriptor)),
    ).resolves.toMatchObject({ ok: true, entries: 1 });
  }
  const embedded = Buffer.concat([
    Buffer.from("x"),
    Buffer.from("PK\x03\x04", "latin1"),
  ]);
  await expect(inspect(stored(embedded))).resolves.toMatchObject({
    ok: false,
    problem: "EMBEDDED_ZIP_RECORD",
  });
  // Split across the 8 MiB piece boundary.
  const split = Buffer.alloc(8 * MB + 16);
  split.write("PK\x05\x06", 8 * MB - 2, "latin1");
  await expect(inspect(stored(split))).resolves.toMatchObject({
    ok: false,
    problem: "EMBEDDED_ZIP_RECORD",
  });

  // Over the cap: refused from the central sizes, before any local read.
  const big = stored(Buffer.alloc(16));
  big.writeUInt32LE(65 * MB, big.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 20);
  let reads = 0;
  const result = await inspectZip(
    async (start, end) => {
      reads += 1;
      return new Uint8Array(big.subarray(start, end + 1));
    },
    big.length,
    { checkEntryTypes: true },
  );
  expect(result).toMatchObject({
    ok: false,
    problem: "DEEP_SCAN_TOO_LARGE",
  });
  // Only the tail and the central directory were read.
  expect(reads).toBe(2);
});

/** Codex re-review repros: each extracted an unlisted payload.exe with macOS tar. */
const REREVIEW_FIXTURES = {
  emptyDirectoryHiddenLocal:
    "UEsDBBQAAAgAAAAAAAAIge7vKAAAACgAAAALAAAAcGF5bG9hZC5leGVNWiBpbmVydCByZXZpZXcgZml4dHVyZTsgbmV2ZXIgZXhlY3V0ZWQKUEsFBgAAAAAAAAAAAAAAAFEAAAAAAA==",
  localStoredCentralDeflate:
    "UEsDBBQACAgAAAAAAAAAAAAAAAAAAAAAAAAJAAAAbm90ZXMudHh0aGVsbG9QSwcIhqYQNgUAAAAFAAAAUEsDBBQAAAgAAAAAAAAIge7vKAAAACgAAAALAAAAcGF5bG9hZC5leGVNWiBpbmVydCByZXZpZXcgZml4dHVyZTsgbmV2ZXIgZXhlY3V0ZWQKUEsHCIJfe0RmAAAAZgAAAFBLAQIUABQACAgIAAAAAACCX3tEZgAAAGYAAAAJAAAAAAAAAAAAAAAAAAAAAABub3Rlcy50eHRQSwUGAAAAAAEAAQA3AAAAnQAAAAAA",
  deflateDescriptorHiddenLocal:
    "UEsDBBQACAgIAAAAAAAAAAAAAAAAAAAAAAAJAAAAbm90ZXMudHh0y0jNyckHAFBLBwiGphA2BwAAAAUAAABQSwMEFAAACAAAAAAAAAiB7u8oAAAAKAAAAAsAAABwYXlsb2FkLmV4ZU1aIGluZXJ0IHJldmlldyBmaXh0dXJlOyBuZXZlciBleGVjdXRlZApQSwcIhqYQNmgAAAAFAAAAUEsBAhQAFAAICAgAAAAAAIamEDZoAAAABQAAAAkAAAAAAAAAAAAAAAAAAAAAAG5vdGVzLnR4dFBLBQYAAAAAAQABADcAAACfAAAAAAA=",
  normalStored:
    "UEsDBBQAAAgAAAAAAACGphA2BQAAAAUAAAAJAAAAbm90ZXMudHh0aGVsbG9QSwECFAAUAAAIAAAAAAAAhqYQNgUAAAAFAAAACQAAAAAAAAAAAAAAAAAAAAAAbm90ZXMudHh0UEsFBgAAAAABAAEANwAAACwAAAAAAA==",
} as const;
const fixture = (name: keyof typeof REREVIEW_FIXTURES) =>
  Buffer.from(REREVIEW_FIXTURES[name], "base64");

it("refuses records before an empty directory and local/central method or flag mismatches", async () => {
  await expect(inspect(fixture("normalStored"))).resolves.toMatchObject({
    ok: true,
    entries: 1,
  });
  await expect(
    inspect(fixture("emptyDirectoryHiddenLocal")),
  ).resolves.toMatchObject({ ok: false, problem: "EMPTY_ARCHIVE" });
  await expect(
    inspect(fixture("localStoredCentralDeflate")),
  ).resolves.toMatchObject({ ok: false, problem: "LOCAL_HEADER_MISMATCH" });
  await expect(inspect(buildZip([]))).resolves.toMatchObject({
    ok: false,
    problem: "EMPTY_ARCHIVE",
  });
});

it("accounts for every byte: empty directories, the gap before the end record and the comment", async () => {
  // Codex round 3: a local payload.exe, then an EOCD claiming no entries at offset 0.
  const hidden = buildZip([{ name: "payload.exe", hidden: true }]);
  hidden.writeUInt32LE(0, hidden.length - 6);
  await expect(inspect(hidden)).resolves.toMatchObject({
    ok: false,
    problem: "EMPTY_ARCHIVE",
  });
  // The same with the directory size stretched over the local record.
  hidden.writeUInt32LE(hidden.length - 22, hidden.length - 10);
  await expect(inspect(hidden)).resolves.toMatchObject({
    ok: false,
    problem: "EMPTY_ARCHIVE",
  });

  // Bytes between the central directory and the EOCD.
  const zip = buildZip([{ name: "guide.txt" }]);
  const gap = Buffer.concat([
    zip.subarray(0, zip.length - 22),
    Buffer.from("PK\x03\x04 smuggled", "latin1"),
    zip.subarray(zip.length - 22),
  ]);
  await expect(inspect(gap)).resolves.toMatchObject({
    ok: false,
    problem: "UNLISTED_DATA",
  });
  // A ZIP record signature in the comment.
  await expect(
    inspect(
      buildZip(
        [{ name: "guide.txt" }],
        Buffer.from("made by PK\x01\x02 tool", "latin1"),
      ),
    ),
  ).resolves.toMatchObject({ ok: false, problem: "UNLISTED_DATA" });
});

it("inflates bit-3 DEFLATE entries and requires each stream to end at its central size", async () => {
  // macOS Archive Utility and streamed zipfile/ZipOutputStream archives look like this.
  const macStyle = buildZip([
    {
      name: "guide/intro.txt",
      descriptor: "signed",
      ...deflated("intro ".repeat(400)),
    },
    {
      name: "__MACOSX/guide/._intro.txt",
      descriptor: "signed",
      ...deflated("resource fork"),
    },
    { name: "guide/notes.txt", descriptor: "unsigned", ...deflated("notes") },
  ]);
  await expect(inspect(macStyle)).resolves.toMatchObject({
    ok: true,
    entries: 3,
  });

  // A valid stream and descriptor end early, hiding a payload.exe record inside the declared size.
  await expect(
    inspect(fixture("deflateDescriptorHiddenLocal")),
  ).resolves.toMatchObject({ ok: false, problem: "UNLISTED_DATA" });

  const body = deflated("checksummed text");
  await expect(
    inspect(
      buildZip([
        {
          name: "a.txt",
          descriptor: "signed",
          ...body,
          crc: (body.crc ^ 1) >>> 0,
        },
      ]),
    ),
  ).resolves.toMatchObject({ ok: false, problem: "ENTRY_DATA_MISMATCH" });
  await expect(
    inspect(buildZip([{ name: "a.bin", descriptor: "signed", method: 12 }])),
  ).resolves.toMatchObject({ ok: false, problem: "UNVERIFIABLE_ENTRY" });

  // Over the shared budget: refused from the central sizes after only the tail and directory reads.
  const big = buildZip([
    { name: "a.txt", descriptor: "signed", ...deflated("x") },
  ]);
  big.writeUInt32LE(65 * MB, big.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 20);
  let reads = 0;
  const result = await inspectZip(
    async (start, end) => {
      reads += 1;
      return new Uint8Array(big.subarray(start, end + 1));
    },
    big.length,
    { checkEntryTypes: true },
  );
  expect(result).toMatchObject({ ok: false, problem: "DEEP_SCAN_TOO_LARGE" });
  expect(reads).toBe(2);
});

it("refuses macros and embedded OLE or ActiveX objects in a document container only", async () => {
  const doc = [{ name: "[Content_Types].xml" }, { name: "word/document.xml" }];
  await expect(inspect(buildZip(doc), false)).resolves.toMatchObject({
    ok: true,
  });
  // A chart's workbook and printer settings are ordinary parts of a clean document.
  await expect(
    inspect(
      buildZip([
        ...doc,
        { name: "word/embeddings/Microsoft_Excel_Sheet1.xlsx" },
        { name: "word/printerSettings/printerSettings1.bin" },
      ]),
      false,
    ),
  ).resolves.toMatchObject({ ok: true });

  const cases: Array<[string, string]> = [
    ["word/vbaProject.bin", "OFFICE_MACRO"],
    ["xl/VBAPROJECT.BIN", "OFFICE_MACRO"],
    ["ppt/vbaProject.bin.", "OFFICE_MACRO"],
    ["xl/macrosheets/sheet1.xml", "OFFICE_MACRO"],
    ["word/vbaData.xml", "OFFICE_MACRO"],
    ["word/embeddings/oleObject1.bin", "EMBEDDED_OBJECT"],
    ["xl/embeddings/package.bin", "EMBEDDED_OBJECT"],
    ["word/activeX/activeX1.bin", "EMBEDDED_OBJECT"],
  ];
  for (const [name, problem] of cases) {
    await expect(
      inspect(buildZip([...doc, { name }]), false),
    ).resolves.toMatchObject({ ok: false, problem });
  }

  // A plain ZIP product keeps the entry-type rules instead.
  await expect(
    inspect(buildZip([{ name: "word/vbaProject.bin" }]), true),
  ).resolves.toMatchObject({ ok: true });
  expect(describeRejectReason("ZIP_OFFICE_MACRO")).toMatchObject({
    code: "ZIP_OFFICE_MACRO",
    message: ASSET_REJECT_MESSAGES.ZIP_OFFICE_MACRO,
  });
  expect(
    describeRejectReason("ZIP_EMBEDDED_OBJECT:oleObject1.bin"),
  ).toMatchObject({ code: "ZIP_EMBEDDED_OBJECT" });
});
