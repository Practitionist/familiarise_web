/**
 * @jest-environment node
 */
import { inspectZip } from "@/lib/digital-products/zip-inspect";
import { checkFileSignature } from "@/lib/digital-products/file-signature";

interface Entry {
  name: string;
  compressed?: number;
  uncompressed?: number;
  flags?: number;
  madeBy?: number;
  externalAttrs?: number;
}

/** A structurally valid archive; entry data is zero filler of the compressed size. */
function buildZip(entries: Entry[], comment = Buffer.alloc(0)): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const compressed = e.compressed ?? 16;
    const uncompressed = e.uncompressed ?? compressed;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.flags ?? 0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    const data = Buffer.alloc(compressed);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.madeBy ?? 20, 4);
    central.writeUInt16LE(e.flags ?? 0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.externalAttrs ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
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
  await expect(inspect(withDecoy("padding"))).resolves.toMatchObject({
    ok: false,
    problem: "EXECUTABLE_ENTRY",
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
  ).toEqual({ ok: false, problem: "POLYGLOT" });
});
