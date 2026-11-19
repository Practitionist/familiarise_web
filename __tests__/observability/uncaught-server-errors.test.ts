/**
 * @jest-environment node
 *
 * An uncaught server error must reach the transport.
 *
 * `onRequestError` must keep a Netlify function alive until its envelope is
 * out, and a preview deploy sends no error event to the shared project.
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
import { initSentry, resetSentryBudgetState } from "../../sentry.shared.config";
import {
  SYNTHETIC_DSN,
  slowCollectingTransport,
} from "../fixtures/sentry-fake-transport";

const delivered: Sentry.Event[] = [];

// `Sentry.init` is a no-op once a client is bound, so the SDK starts once and
// `beforeSend` reads the environment per event.
function startSdk(): void {
  process.env.NEXT_PUBLIC_SENTRY_DSN = SYNTHETIC_DSN;
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";
  initSentry({
    defaultIntegrations: false,
    sendClientReports: false,
    tracesSampleRate: 0,
    transport: slowCollectingTransport(delivered),
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
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";
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

describe("previews report errors like production", () => {
  it("delivers an uncaught render error and a handled error from a preview", async () => {
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "preview";
    await onRequestError(p2022(), request, renderContext);
    Sentry.captureException(new Error("handled preview failure"));
    await Sentry.flush(2_000);
    const fromPreview = delivered.length;
    const values = delivered.flatMap(
      (event) => event.exception?.values?.map((v) => v.value) ?? [],
    );
    expect(values).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SupportCase.legalHoldAt"),
        "handled preview failure",
      ]),
    );

    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";
    Sentry.captureException(new Error("handled production failure"));
    await Sentry.flush(2_000);
    expect(delivered.length).toBe(fromPreview + 1);
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
