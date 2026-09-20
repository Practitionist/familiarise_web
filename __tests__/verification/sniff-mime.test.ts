/**
 * The declared Content-Type is whatever the client said; the bytes decide.
 */

import {
  declaredMimeMatchesBytes,
  sniffMime,
} from "../../lib/storage/sniff-mime";

const bytes = (...b: number[]) => new Uint8Array(b);
const pdf = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);
const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const webp = bytes(
  0x52,
  0x49,
  0x46,
  0x46,
  0x24,
  0x00,
  0x00,
  0x00,
  0x57,
  0x45,
  0x42,
  0x50,
);
const exe = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00);

describe("sniffMime", () => {
  it.each([
    ["pdf", pdf, "application/pdf"],
    ["png", png, "image/png"],
    ["jpeg", jpeg, "image/jpeg"],
    ["webp", webp, "image/webp"],
  ])("detects %s", (_label, input, expected) => {
    expect(sniffMime(input)).toBe(expected);
  });

  it("returns null for anything else, including an executable and an empty file", () => {
    expect(sniffMime(exe)).toBeNull();
    expect(sniffMime(bytes())).toBeNull();
    // RIFF without the WEBP form tag is not WEBP.
    expect(
      sniffMime(
        bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20),
      ),
    ).toBeNull();
  });
});

describe("declaredMimeMatchesBytes", () => {
  it("accepts a match and the image/jpg alias", () => {
    expect(declaredMimeMatchesBytes("application/pdf", pdf)).toBe(true);
    expect(declaredMimeMatchesBytes("image/jpg", jpeg)).toBe(true);
  });

  it("refuses a renamed executable and a type/bytes mismatch", () => {
    expect(declaredMimeMatchesBytes("application/pdf", exe)).toBe(false);
    expect(declaredMimeMatchesBytes("image/png", jpeg)).toBe(false);
  });
});
