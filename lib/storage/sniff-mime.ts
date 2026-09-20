/**
 * Magic-byte sniff for the four document types the verification upload
 * accepts. The `Content-Type` a browser sends is whatever the client claims;
 * a renamed executable arrives as `application/pdf`. The first bytes do not
 * lie, and for these four formats they are unambiguous, so no dependency is
 * needed. Returns the detected type or null when the bytes match none.
 */

export type SniffedMime =
  | "application/pdf"
  | "image/png"
  | "image/jpeg"
  | "image/webp";

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46]; // RIFF
const WEBP = [0x57, 0x45, 0x42, 0x50]; // WEBP at offset 8

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

export function sniffMime(bytes: Uint8Array): SniffedMime | null {
  if (startsWith(bytes, PDF)) return "application/pdf";
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8))
    return "image/webp";
  return null;
}

/** `image/jpg` is a common browser alias for `image/jpeg`. */
export function normalizeDeclaredMime(declared: string): string {
  return declared === "image/jpg" ? "image/jpeg" : declared;
}

/** True when the bytes are one of the accepted formats AND agree with the declared type. */
export function declaredMimeMatchesBytes(
  declared: string,
  bytes: Uint8Array,
): boolean {
  const sniffed = sniffMime(bytes);
  return sniffed !== null && sniffed === normalizeDeclaredMime(declared);
}
