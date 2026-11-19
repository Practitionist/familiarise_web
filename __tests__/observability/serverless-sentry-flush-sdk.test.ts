/**
 * @jest-environment node
 *
 * A direct `Sentry.captureException` on Netlify must reach the transport.
 *
 * This drives the REAL server client (`NodeClient`) booted by
 * `sentry.server.config.ts` with `NETLIFY` set, over a slow fake HTTP layer.
 * The flush must be handed to `after()` before the capture call returns, while
 * the request scope is still open, and awaiting that handed-off task alone must
 * deliver the event.
 */

import * as Sentry from "@sentry/nextjs";

type AfterTask = () => Promise<void>;
let afterImpl: (task: AfterTask) => void = () => {
  throw new Error("`after` was called outside a request scope");
};
jest.mock("next/server", () => ({
  after: (task: AfterTask) => afterImpl(task),
}));

import { initSentry, resetSentryBudgetState } from "../../sentry.shared.config";

const SYNTHETIC_DSN =
  "https://0123456789abcdef0123456789abcdef@o0123456789abcdef.ingest.us.sentry.io/0123456789abcdef";

type TransportOptions = Parameters<typeof Sentry.createTransport>[0];

const delivered: Sentry.Event[] = [];
const ORIGINAL_NETLIFY = process.env.NETLIFY;

// `Sentry.init` is a no-op once a client is bound, so this test's transport
// survives the server config's own `initSentry()` call.
beforeAll(async () => {
  process.env.NEXT_PUBLIC_SENTRY_DSN = SYNTHETIC_DSN;
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";
  process.env.NETLIFY = "true";
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
  await import("../../sentry.server.config");
});

beforeEach(() => {
  delivered.length = 0;
  resetSentryBudgetState();
});

afterEach(() => {
  afterImpl = () => {
    throw new Error("`after` was called outside a request scope");
  };
});

afterAll(async () => {
  await Sentry.close(0);
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  delete process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
  if (ORIGINAL_NETLIFY === undefined) delete process.env.NETLIFY;
  else process.env.NETLIFY = ORIGINAL_NETLIFY;
});

/** Records each `after()` task and whether the capture call had returned yet. */
function recordAfterCalls(isReturned: () => boolean) {
  const record = { tasks: [] as AfterTask[], beforeReturn: [] as boolean[] };
  afterImpl = (task) => {
    record.tasks.push(task);
    record.beforeReturn.push(!isReturned());
  };
  return record;
}

describe("a direct capture on Netlify schedules its own flush", () => {
  it("hands the flush to after() inside captureException, and that flush delivers", async () => {
    let returned = false;
    const record = recordAfterCalls(() => returned);

    Sentry.captureException(new Error("route caught and answered 500"));
    returned = true;

    expect(record.beforeReturn).toEqual([true]);
    expect(delivered).toHaveLength(0);
    await record.tasks[0]?.();
    expect(
      delivered.flatMap((e) => e.exception?.values?.map((v) => v.value) ?? []),
    ).toEqual(["route caught and answered 500"]);
  });

  it("does the same for captureMessage", async () => {
    let returned = false;
    const record = recordAfterCalls(() => returned);

    Sentry.captureMessage("refund webhook rejected", "error");
    returned = true;

    expect(record.beforeReturn).toEqual([true]);
    await record.tasks[0]?.();
    expect(delivered.map((e) => e.message)).toEqual([
      "refund webhook rejected",
    ]);
  });

  it("adds no flush for a transaction event", async () => {
    const tasks: AfterTask[] = [];
    afterImpl = (task) => {
      tasks.push(task);
    };

    Sentry.captureEvent({
      type: "transaction",
      transaction: "GET /api/health",
      start_timestamp: 0,
      timestamp: 1,
    });

    expect(tasks).toHaveLength(0);
    await Sentry.flush(2_000);
  });
});
