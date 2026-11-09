// Invariant: an error-boundary capture before the lazy Sentry init is queued
// (bounded), sent after `initSentry()` runs once, and passes straight through after.

import type * as ClientCaptureModule from "../../lib/observability/client-capture";

const order: string[] = [];
const initSentry = jest.fn(() => {
  order.push("init");
});
const captureException = jest.fn((_error: unknown, _hint: unknown) => {
  order.push("capture");
  return "sdk-id";
});

jest.mock("../../sentry.shared.config", () => ({ initSentry }));
jest.mock("@sentry/nextjs", () => ({ captureException }));

type ClientCapture = typeof ClientCaptureModule;

function loadClientCapture(): ClientCapture {
  let mod: ClientCapture | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<ClientCapture>(
      "../../lib/observability/client-capture",
    );
  });
  return mod as ClientCapture;
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  order.length = 0;
  initSentry.mockClear();
  captureException.mockClear();
});

describe("captureClientException", () => {
  it("queues a capture made before init and sends it after initSentry", async () => {
    const { captureClientException } = loadClientCapture();
    const error = new Error("render crash");

    const id = captureClientException(error, {
      tags: { subsystem: "client" },
      extra: { componentStack: "at Calendar" },
    });

    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(captureException).not.toHaveBeenCalled();
    await settle();

    expect(initSentry).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["init", "capture"]);
    expect(captureException).toHaveBeenCalledWith(error, {
      event_id: id,
      captureContext: {
        tags: { subsystem: "client" },
        extra: { componentStack: "at Calendar" },
      },
    });
  });

  it("initialises once however many captures and loaders race", async () => {
    const { captureClientException, ensureSentry } = loadClientCapture();
    void ensureSentry();
    captureClientException(new Error("a"));
    captureClientException(new Error("b"));
    void ensureSentry();
    await settle();

    expect(initSentry).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it("bounds the pre-init queue and drops the overflow", async () => {
    const { captureClientException, MAX_QUEUED_CAPTURES } = loadClientCapture();
    const ids = Array.from({ length: MAX_QUEUED_CAPTURES + 5 }, (_, i) =>
      captureClientException(new Error(`crash ${i}`)),
    );

    expect(ids.filter(Boolean)).toHaveLength(MAX_QUEUED_CAPTURES);
    expect(ids.slice(MAX_QUEUED_CAPTURES)).toEqual(Array(5).fill(undefined));
    await settle();
    expect(captureException).toHaveBeenCalledTimes(MAX_QUEUED_CAPTURES);
  });

  it("captures synchronously once Sentry is initialised", async () => {
    const { captureClientException, ensureSentry } = loadClientCapture();
    await ensureSentry();
    initSentry.mockClear();

    const id = captureClientException(new Error("later"), {
      tags: { subsystem: "dashboard" },
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      event_id: id,
      captureContext: { tags: { subsystem: "dashboard" } },
    });
    expect(initSentry).not.toHaveBeenCalled();
  });

  it("swallows a failed Sentry load", async () => {
    initSentry.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    const { captureClientException } = loadClientCapture();

    expect(() => captureClientException(new Error("x"))).not.toThrow();
    await settle();
    expect(captureException).not.toHaveBeenCalled();
  });
});
