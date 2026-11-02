import type { DigitalProductMimeType } from "@/lib/digital-products/constants";

function startsWith(buf: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (buf.length < at + sig.length) return false;
  return sig.every((byte, i) => buf[at + i] === byte);
}

function asciiAt(buf: Uint8Array, at: number, text: string): boolean {
  return startsWith(
    buf,
    Array.from(text, (ch) => ch.charCodeAt(0)),
    at,
  );
}

const EXECUTABLE_SIGNATURES: readonly (readonly number[])[] = [
  [0x4d, 0x5a], // PE "MZ"
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32, little-endian
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64, little-endian
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal / Java class
  [0x23, 0x21], // "#!"
];

/** Markup a browser or reader could execute, hidden inside a binary header. */
const POLYGLOT_MARKERS = ["<script", "<html", "<?php", "<svg"];
const PDF_ACTIVE_MARKERS = ["/javascript", "/launch", "/js "];

const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];
const OOXML_MIMES: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const TEXT_MIMES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
]);
/** Audio-only MP4 brands; a video brand is refused because v1 sells no video. */
const M4A_BRANDS = ["M4A ", "M4B "];

function matchesMime(h: Uint8Array, mime: DigitalProductMimeType): boolean {
  switch (mime) {
    case "application/pdf":
      return asciiAt(h, 0, "%PDF-");
    case "application/epub+zip":
      // OCF requires an uncompressed `mimetype` entry first.
      return (
        startsWith(h, ZIP_LOCAL_HEADER) &&
        asciiAt(h, 30, "mimetype") &&
        asciiAt(h, 38, "application/epub+zip")
      );
    case "application/zip":
      return (
        startsWith(h, ZIP_LOCAL_HEADER) ||
        startsWith(h, [0x50, 0x4b, 0x05, 0x06]) // empty archive
      );
    case "image/png":
      return startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(h, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return asciiAt(h, 0, "RIFF") && asciiAt(h, 8, "WEBP");
    case "audio/mpeg":
      return (
        asciiAt(h, 0, "ID3") ||
        (h.length >= 2 && h[0] === 0xff && (h[1] & 0xe0) === 0xe0)
      );
    case "audio/mp4":
      return asciiAt(h, 4, "ftyp") && M4A_BRANDS.some((b) => asciiAt(h, 8, b));
    case "audio/wav":
      return asciiAt(h, 0, "RIFF") && asciiAt(h, 8, "WAVE");
    default:
      if (OOXML_MIMES.has(mime)) return startsWith(h, ZIP_LOCAL_HEADER);
      // Text carries no magic; a NUL byte means it is binary.
      return TEXT_MIMES.has(mime) && !h.includes(0x00);
  }
}

function lowerAscii(h: Uint8Array): string {
  let out = "";
  for (const byte of h) out += String.fromCharCode(byte).toLowerCase();
  return out;
}

export type SignatureProblem = "EXECUTABLE" | "POLYGLOT" | "SIGNATURE_MISMATCH";

/**
 * Checks a file's first bytes against its declared MIME. Executables are
 * refused whatever they claim; binary types also refuse embedded markup.
 */
export function checkFileSignature(
  header: Uint8Array,
  mime: DigitalProductMimeType,
): { ok: true } | { ok: false; problem: SignatureProblem; detail?: string } {
  if (EXECUTABLE_SIGNATURES.some((sig) => startsWith(header, sig))) {
    return { ok: false, problem: "EXECUTABLE" };
  }
  if (!matchesMime(header, mime)) {
    return { ok: false, problem: "SIGNATURE_MISMATCH" };
  }
  if (!TEXT_MIMES.has(mime)) {
    const text = lowerAscii(header);
    const markers =
      mime === "application/pdf"
        ? [...POLYGLOT_MARKERS, ...PDF_ACTIVE_MARKERS]
        : POLYGLOT_MARKERS;
    const marker = markers.find((m) => text.includes(m));
    if (marker)
      return { ok: false, problem: "POLYGLOT", detail: marker.trim() };
  }
  return { ok: true };
}
