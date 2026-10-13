/**
 * @jest-environment node
 */

import {
  fetchWithReauth,
  registerReauthHandler,
  withReauth,
} from "@/lib/auth/reauth-client";

const reauthRequired = () =>
  new Response(JSON.stringify({ code: "REAUTH_REQUIRED" }), { status: 403 });

describe("reauth-client", () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
    registerReauthHandler(null);
  });

  it("re-authenticates and retries once on REAUTH_REQUIRED", async () => {
    const handler = jest.fn().mockResolvedValue(true);
    registerReauthHandler(handler);
    fetchMock
      .mockResolvedValueOnce(reauthRequired())
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const res = await fetchWithReauth("/api/x", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the refusal when the user cancels", async () => {
    registerReauthHandler(jest.fn().mockResolvedValue(false));
    fetchMock.mockResolvedValueOnce(reauthRequired());
    const res = await fetchWithReauth("/api/x");
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves other 403s alone", async () => {
    const handler = jest.fn();
    registerReauthHandler(handler);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "FORBIDDEN" }), { status: 403 }),
    );
    await fetchWithReauth("/api/x");
    expect(handler).not.toHaveBeenCalled();
  });

  it("retries a BetterAuth client call", async () => {
    registerReauthHandler(jest.fn().mockResolvedValue(true));
    const call = jest
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: "REAUTH_REQUIRED" } })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });
    await expect(withReauth(call)).resolves.toEqual({
      data: { ok: true },
      error: null,
    });
    expect(call).toHaveBeenCalledTimes(2);
  });
});
