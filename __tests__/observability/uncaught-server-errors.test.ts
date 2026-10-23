/**
 * @jest-environment node
 *
 * An uncaught server error must reach the transport.
 *
 * Observed on a deploy preview: a server-rendered page threw Prisma P2022, the
 * Netlify function log had it, Sentry had no event. Two silent losses sat in
 * front of it: preview environments sampled every error at 10% before
 * `beforeSend` could look at the mechanism, and `onRequestError` handed its
 * flush to a `waitUntil` that exists only on Vercel and Cloudflare, so a
 * Netlify function could freeze with the envelope still in flight.
 *
 * This drives the REAL SDK, `initSentry()` and the real `onRequestError`, with
 * the SDK's real transport buffer over a slow fake HTTP layer, so `flush` has
 * something genuinely in flight to wait for.
 */

import * as Sentry from "@sentry/nextjs";

let afterImpl: (task: Promise<unknown>) => void = () => {
  throw new Error("`after` was called outside a request scope");
};
jest.mock("next/server", () => ({
  after: (task: Promise<unknown>) => afterImpl(task),
}));

import { onRequestError } from "../../instrumentation";
import {
  initSentry,
  isThinnedOnPreview,
  isUncaughtNextServerError,
  resetSentryBudgetState,
} from "../../sentry.shared.config";

const SYNTHETIC_DSN =
  "https://0123456789abcdef0123456789abcdef@o0123456789abcdef.ingest.us.sentry.io/0123456789abcdef";

type TransportOptions = Parameters<typeof Sentry.createTransport>[0];

const delivered: Sentry.Event[] = [];

// `Sentry.init` is a no-op once a client is bound, so the SDK starts once, on a
// preview, and `beforeSend` reads the environment per event.
function startSdk(): void {
  process.env.NEXT_PUBLIC_SENTRY_DSN = SYNTHETIC_DSN;
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "preview";
  initSentry({
    defaultIntegrations: false,
    sendClientReports: false,
    tracesSampleRate: 0,
    transport: (options: TransportOptions) =>
      Sentry.createTransport(options, async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        const lines = String(request.body).split("\n").filter(Boolean);
        // Envelope: header line, then an (item header, payload) line pair per item.
        for (let i = 1; i + 1 < lines.length; i += 2) {
          if (JSON.parse(lines[i] ?? "{}").type === "event") {
            delivered.push(JSON.parse(lines[i + 1] ?? "{}") as Sentry.Event);
          }
        }
        return { statusCode: 200 };
      }),
  });
}

function p2022(): Error {
  return Object.assign(
    new Error(
      "Invalid `prisma.supportCase.findFirst()` invocation:\n\nThe column `SupportCase.legalHoldAt` does not exist in the current database.",
    ),
    { name: "PrismaClientKnownRequestError", code: "P2022" },
  );
}

const request = {
  path: "/dashboard/organization/o1/support/requests/c1",
  method: "GET",
  headers: {},
};
const renderContext = {
  routerKind: "App Router" as const,
  routePath: "/dashboard/organization/[orgId]/support/requests/[caseKey]",
  routeType: "render" as const,
};

beforeAll(startSdk);

beforeEach(() => {
  delivered.length = 0;
  resetSentryBudgetState();
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "preview";
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  afterImpl = () => {
    throw new Error("`after` was called outside a request scope");
  };
});

afterAll(async () => {
  await Sentry.close(0);
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  delete process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
});

describe("preview thinning spares uncaught server errors", () => {
  it("delivers an uncaught render error on a preview even on the worst sampling roll", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);

    await onRequestError(p2022(), request, renderContext);

    expect(delivered).toHaveLength(1);
    const mechanism = delivered[0]?.exception?.values?.[0]?.mechanism;
    expect(mechanism).toMatchObject({
      handled: false,
      type: "auto.function.nextjs.on_request_error",
    });
    expect(delivered[0]?.environment).toBe("preview");
  });

  it("still thins ordinary preview errors to a tenth", async () => {
    const roll = jest.spyOn(Math, "random").mockReturnValue(0.99);

    Sentry.captureException(new Error("handled preview failure"));
    await Sentry.flush(2_000);
    expect(delivered).toHaveLength(0);

    roll.mockReturnValue(0.05);
    Sentry.captureException(new Error("another handled preview failure"));
    await Sentry.flush(2_000);
    expect(delivered).toHaveLength(1);
  });

  it("does not thin outside previews", async () => {
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";
    jest.spyOn(Math, "random").mockReturnValue(0.99);

    Sentry.captureException(new Error("handled production failure"));
    await Sentry.flush(2_000);

    expect(delivered).toHaveLength(1);
  });

  it("recognises only Next's unhandled server mechanisms as uncaught", () => {
    const withMechanism = (type: string, handled: boolean): Sentry.Event => ({
      exception: { values: [{ mechanism: { type, handled } }] },
    });
    expect(
      isUncaughtNextServerError(
        withMechanism("auto.function.nextjs.server_component", false),
      ),
    ).toBe(true);
    expect(
      isUncaughtNextServerError(
        withMechanism("auto.function.nextjs.route_handler", false),
      ),
    ).toBe(true);
    expect(isUncaughtNextServerError(withMechanism("generic", true))).toBe(
      false,
    );
    expect(
      isUncaughtNextServerError(
        withMechanism("auto.browser.global_handlers.onerror", false),
      ),
    ).toBe(false);

    expect(isThinnedOnPreview(withMechanism("generic", true), 0.5)).toBe(true);
    expect(
      isThinnedOnPreview(
        withMechanism("auto.function.nextjs.server_action", false),
        0.5,
      ),
    ).toBe(false);
  });
});

describe("onRequestError keeps the function alive until the envelope is out", () => {
  it("returns a promise that settles only after the transport has delivered", async () => {
    await onRequestError(p2022(), request, renderContext);

    // No Sentry.flush here: the awaited hook is the only thing that could
    // have waited for the slow send.
    expect(delivered).toHaveLength(1);
  });

  it("hands the flush to the platform's waitUntil when a request scope exists", async () => {
    let handedOff: Promise<unknown> | undefined;
    afterImpl = (task) => {
      handedOff = task;
    };

    await onRequestError(p2022(), request, renderContext);
    expect(handedOff).toBeInstanceOf(Promise);

    await handedOff;
    expect(delivered).toHaveLength(1);
  });
});
