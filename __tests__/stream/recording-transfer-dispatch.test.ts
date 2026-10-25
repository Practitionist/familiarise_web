/** @jest-environment node */
import { dispatchRecordingTransfer } from "../../lib/stream/dispatch-recording-transfer";

const originalEnv = process.env;
const originalFetch = global.fetch;
beforeEach(() => {
  process.env = {
    ...originalEnv,
    CRON_SECRET: "dispatch-test",
    CRON_TICK_BASE_URL: "https://app.test",
  };
});
afterEach(() => {
  process.env = originalEnv;
  global.fetch = originalFetch;
});

it("accepts only background queue admission and passes the bearer without following redirects", async () => {
  const fetchMock = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue(new Response(null, { status: 202 }));
  global.fetch = fetchMock;
  await expect(dispatchRecordingTransfer()).resolves.toEqual({
    accepted: true,
    job: "transfer-recordings",
  });
  expect(fetchMock).toHaveBeenCalledWith(
    new URL(
      "https://app.test/.netlify/functions/recording-transfer-background",
    ),
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer dispatch-test" },
      signal: expect.any(AbortSignal),
    }),
  );
});

it.each([200, 301, 401, 404, 500, 503])(
  "rejects HTTP %s instead of claiming a copy completed",
  async (status) => {
    global.fetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response(null, { status }));
    await expect(dispatchRecordingTransfer()).rejects.toThrow(`HTTP ${status}`);
  },
);

it.each(["http://app.test", "https://user:pass@app.test", "invalid"])(
  "rejects invalid configured origin %s before sending a bearer",
  async (origin) => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    process.env.CRON_TICK_BASE_URL = origin;
    await expect(dispatchRecordingTransfer()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
