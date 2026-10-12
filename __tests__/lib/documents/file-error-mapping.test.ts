/**
 * @jest-environment node
 */

/**
 * Every code the document, material and recording routes return maps to a
 * status, fixed server text and UI copy; the body's code wins over the status.
 */

import {
  FILE_ERROR_MESSAGE,
  FILE_ERROR_STATUS,
  FileErrorCode,
  friendlyErrorFromResponse,
  friendlyFileError,
} from "@/lib/documents/file-errors";

describe("file error model", () => {
  it("gives every code a status, a message and UI copy", () => {
    for (const code of FileErrorCode.options) {
      const copy = friendlyFileError(code);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.description.length).toBeGreaterThan(0);
      if (code === "NETWORK") continue;
      expect(FILE_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(FILE_ERROR_MESSAGE[code].length).toBeGreaterThan(0);
    }
  });

  it("reads the code from the body, else falls back to the status", async () => {
    const res = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status });
    await expect(
      friendlyErrorFromResponse(res(409, { code: "RECORDING_HAS_BUYERS" })),
    ).resolves.toMatchObject({ code: "RECORDING_HAS_BUYERS" });
    await expect(
      friendlyErrorFromResponse(res(503, { error: "raw vendor text" })),
    ).resolves.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});
