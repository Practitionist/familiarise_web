/**
 * Server events reach Sentry from a Netlify function: on Netlify the server
 * config registers a listener on the SDK client so every error or message
 * event, whichever API captured it, schedules a bounded flush. The flush rides
 * `after()` inside a request and is returned to await outside one, so the
 * instance cannot freeze with the event still queued. Off Netlify nothing is
 * added. The real-SDK timing proof is in serverless-sentry-flush-sdk.test.ts.
 */

type Listener = (event: { type?: string }) => void;
const listeners = new Map<string, Listener[]>();
let fakeClient: { on: jest.Mock } | undefined;
const makeClient = () => ({
  on: jest.fn((hook: string, listener: Listener) => {
    listeners.set(hook, [...(listeners.get(hook) ?? []), listener]);
    return () => undefined;
  }),
});
const flush = jest.fn(async (_timeoutMs?: number) => true);
jest.mock("@sentry/nextjs", () => ({
  flush: (timeoutMs?: number) => flush(timeoutMs),
  getClient: () => fakeClient,
}));
const after = jest.fn();
jest.mock("next/server", () => ({
  after: (task: () => Promise<void>) => after(task),
}));
jest.mock("../../sentry.shared.config", () => ({ initSentry: jest.fn() }));

import { scheduleSentryFlush } from "../../lib/observability/serverless-flush";

const ORIGINAL_NETLIFY = process.env.NETLIFY;

beforeEach(() => {
  jest.clearAllMocks();
  listeners.clear();
  fakeClient = makeClient();
});

afterAll(() => {
  if (ORIGINAL_NETLIFY === undefined) delete process.env.NETLIFY;
  else process.env.NETLIFY = ORIGINAL_NETLIFY;
});

/** Boots the server Sentry config in a fresh registry. */
async function loadServerRuntime(netlify: string | undefined): Promise<void> {
  if (netlify === undefined) delete process.env.NETLIFY;
  else process.env.NETLIFY = netlify;
  await jest.isolateModulesAsync(async () => {
    await import("../../sentry.server.config");
  });
}

function emitPreprocess(event: { type?: string }): void {
  for (const listener of listeners.get("preprocessEvent") ?? [])
    listener(event);
}

describe("scheduleSentryFlush", () => {
  it("hands a 2 s flush to after() inside a request, which awaits it", async () => {
    let release: (drained: boolean) => void = () => undefined;
    flush.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );

    await scheduleSentryFlush();

    expect(after).toHaveBeenCalledTimes(1);
    const task = after.mock.calls[0][0] as () => Promise<void>;
    let settled = false;
    const running = task().then(() => (settled = true));
    await Promise.resolve();
    expect(flush).toHaveBeenCalledWith(2_000);
    expect(settled).toBe(false);
    release(true);
    await running;
    expect(settled).toBe(true);
  });

  it("returns the flush for the caller to await outside a request", async () => {
    after.mockImplementationOnce(() => {
      throw new Error("after() called outside a request scope");
    });
    let release: (drained: boolean) => void = () => undefined;
    flush.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );

    let settled = false;
    const pending = scheduleSentryFlush().then(() => (settled = true));
    await Promise.resolve();
    expect(flush).toHaveBeenCalledWith(2_000);
    expect(settled).toBe(false);
    release(true);
    await pending;
    expect(settled).toBe(true);
  });

  it("never rejects when the flush times out or throws", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    after.mockImplementation(() => {
      throw new Error("no request scope");
    });
    flush.mockResolvedValueOnce(false);
    await expect(scheduleSentryFlush()).resolves.toBeUndefined();
    flush.mockRejectedValueOnce(new Error("transport down"));
    await expect(scheduleSentryFlush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    after.mockReset();
    warn.mockRestore();
  });
});

describe("the server runtime on Netlify flushes after every server event", () => {
  it("schedules a flush for error and message events", async () => {
    await loadServerRuntime("true");

    expect(fakeClient?.on).toHaveBeenCalledTimes(1);
    emitPreprocess({});
    emitPreprocess({ type: undefined });

    expect(after).toHaveBeenCalledTimes(2);
  });

  it("adds no flush for a transaction", async () => {
    await loadServerRuntime("true");

    emitPreprocess({ type: "transaction" });

    expect(after).not.toHaveBeenCalled();
  });

  it("registers nothing off Netlify", async () => {
    await loadServerRuntime(undefined);

    expect(fakeClient?.on).not.toHaveBeenCalled();
  });

  it("registers nothing when no client exists, as during next build", async () => {
    const client = fakeClient;
    fakeClient = undefined;

    await expect(loadServerRuntime("true")).resolves.toBeUndefined();
    expect(client?.on).not.toHaveBeenCalled();
  });

  it("the listener never throws when no request scope exists", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    after.mockImplementationOnce(() => {
      throw new Error("after() called outside a request scope");
    });
    await loadServerRuntime("true");

    expect(() => emitPreprocess({})).not.toThrow();
    expect(flush).toHaveBeenCalledWith(2_000);
  });
});
