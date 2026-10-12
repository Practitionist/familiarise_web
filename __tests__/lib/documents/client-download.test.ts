/**
 * @jest-environment jsdom
 */
import { downloadAppointmentDocument } from "@/lib/documents/client-download";
import { friendlyErrorFromResponse } from "@/lib/documents/file-errors";

/** jsdom has no fetch Response; only the fields the helpers read. */
const fakeResponse = (status: number, json: () => Promise<unknown>) =>
  ({ ok: status >= 200 && status < 300, status, json }) as Response;
const jsonResponse = (status: number, body: unknown) =>
  fakeResponse(status, async () => body);

describe("file error copy is keyed on the code, never the server message", () => {
  const LEAK = "Document storage is not properly configured on the server.";

  it.each([
    [
      401,
      { code: "UNAUTHORIZED" },
      "You were signed out. Sign in again to open this file.",
    ],
    [
      403,
      { code: "APPOINTMENT_TERMINAL" },
      "This booking was cancelled or closed, so its files are no longer available.",
    ],
    [403, { code: "FORBIDDEN" }, "You don't have access to this file."],
    [
      404,
      { code: "NOT_FOUND" },
      "This file was removed or is no longer shared with you.",
    ],
    [410, {}, "This file was removed or is no longer shared with you."],
    [413, null, "Files can be up to 10 MB."],
    [
      415,
      {},
      "Upload a PDF, Word document, image (JPG, PNG, GIF) or text file.",
    ],
    [
      429,
      { code: "RATE_LIMITED" },
      "Too many requests. Try again in a minute.",
    ],
    [
      500,
      { code: "STORAGE_CONFIG_ERROR" },
      "Files are temporarily unavailable. Try again in a moment.",
    ],
    [500, { code: "SERVER_ERROR" }, "Something went wrong. Try again."],
    [
      409,
      { code: "SUPERSEDED" },
      "A newer version was uploaded. Refresh to see it.",
    ],
    [
      409,
      { code: "THREAD_IN_REVIEW" },
      "Your expert is reviewing this version. You can upload again once they respond.",
    ],
    [
      409,
      { code: "VERSION_LIMIT_REACHED" },
      "You've used all 10 versions for this document. Start a new document instead.",
    ],
  ])("%i %j", async (status, body, description) => {
    const res =
      body === null
        ? fakeResponse(status, async () => {
            throw new SyntaxError("Unexpected token <");
          })
        : jsonResponse(status, { ...body, message: LEAK, error: LEAK });
    const copy = await friendlyErrorFromResponse(res);
    expect(copy.description).toBe(description);
    expect(JSON.stringify(copy)).not.toContain(LEAK);
  });

  it("tells only the uploader to re-upload a file that never finished saving", async () => {
    const body = { code: "STORAGE_MISSING" };
    const own = await friendlyErrorFromResponse(jsonResponse(404, body), {
      isUploader: true,
    });
    const theirs = await friendlyErrorFromResponse(jsonResponse(404, body), {
      isUploader: false,
    });
    expect(own.description).toBe(
      "This file didn't finish saving. Upload it again.",
    );
    expect(theirs.description).toBe(
      "This file didn't finish saving. Ask the person who shared it to upload it again.",
    );
  });
});

describe("downloadAppointmentDocument", () => {
  const originalFetch = global.fetch;
  const startHref = window.location.href;
  let clicked: string[];
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    clicked = [];
    jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this.href);
      });
    openSpy = jest.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("saves through a detached anchor and never opens a window or moves this tab", async () => {
    const signedUrl = "https://storage.example.com/signed/cv.pdf?token=abc";
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { signedUrl, originalName: "cv.pdf" }),
      ) as unknown as typeof fetch;

    const error = await downloadAppointmentDocument("apt-1", "doc-1");

    expect(error).toBeNull();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/appointments/apt-1/documents/doc-1/download?disposition=attachment&format=json",
      expect.anything(),
    );
    expect(clicked).toEqual([signedUrl]);
    expect(openSpy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(startHref);
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });

  it("returns fixed copy on a refusal and on a network failure, with nothing clicked", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(403, { code: "APPOINTMENT_TERMINAL" }),
      )
      .mockRejectedValueOnce(
        new TypeError("Failed to fetch"),
      ) as unknown as typeof fetch;

    expect(await downloadAppointmentDocument("apt-1", "doc-1")).toMatchObject({
      code: "APPOINTMENT_TERMINAL",
    });
    expect(await downloadAppointmentDocument("apt-1", "doc-1")).toMatchObject({
      code: "NETWORK",
      description: "Check your connection and try again.",
    });
    expect(clicked).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
