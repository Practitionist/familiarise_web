import {
  openAppointmentDocument,
  openPlanMaterial,
  resolveFriendlyFileError,
} from "@/lib/documents/client-download";

describe("client-download signed URL preflight helper", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test("maps server status codes and error codes into human-friendly messages", () => {
    expect(resolveFriendlyFileError(404, "STORAGE_MISSING")).toEqual({
      title: "File unavailable",
      description:
        "This file is missing from storage or has been removed. Upload a replacement version to restore access.",
    });

    expect(resolveFriendlyFileError(403, "APPOINTMENT_TERMINAL")).toEqual({
      title: "Access unavailable",
      description:
        "Files from closed, cancelled, or unpaid sessions are no longer accessible.",
    });

    expect(resolveFriendlyFileError(401, "UNAUTHORIZED")).toEqual({
      title: "Sign in required",
      description:
        "Your session expired. Please sign in again to access files.",
    });
  });

  test("reports friendly error without opening raw JSON tab when storage is missing", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        error: "File unavailable",
        code: "STORAGE_MISSING",
      }),
    }) as unknown as typeof fetch;

    const onError = jest.fn();
    const ok = await openAppointmentDocument(
      "appt-1",
      "doc-1",
      "attachment",
      onError,
      "resume.pdf",
    );

    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith({
      title: "File unavailable",
      description:
        "This file is missing from storage or has been removed. Upload a replacement version to restore access.",
    });
  });

  test("opens fresh presigned URL when plan material preflight succeeds", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        signedUrl: "https://storage.example.com/signed/guide.pdf?token=abc",
        originalName: "guide.pdf",
        previewable: true,
      }),
    }) as unknown as typeof fetch;

    const openSpy = jest.spyOn(window, "open").mockReturnValue({} as Window);
    const onError = jest.fn();

    const ok = await openPlanMaterial("mat-1", "inline", onError, "guide.pdf");

    expect(ok).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      "https://storage.example.com/signed/guide.pdf?token=abc",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
