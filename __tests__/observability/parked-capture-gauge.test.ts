/** @jest-environment node */

/**
 * The parked-capture gauge rides on the tick summary as
 * `oldestPendingAgeS.parkedCaptures`: the age of the Stuck work queue's first
 * row, read through the queue's own `where`, and 0 when nothing is parked.
 */

const NOW = new Date("2026-11-23T10:00:00Z");
const SEC = 1000;

/** The row the queue's Prisma `select` returns. */
const parkedRow = {
  id: "pay-parked-1",
  appointmentId: "appt-1",
  description: "REQUIRES_MANUAL_RECOVERY: Trial booking appt-1 has no trial.",
  capturedAt: new Date(NOW.getTime() - 90 * SEC),
  createdAt: new Date(NOW.getTime() - 100 * SEC),
};
let parked: (typeof parkedRow)[] = [];

const mockEmpty = () => ({
  findMany: jest.fn(async () => []),
  count: jest.fn(async () => 0),
});
const mockPayment = {
  findMany: jest.fn(async (args: { where: unknown }) =>
    JSON.stringify(args.where).includes("REQUIRES_MANUAL_RECOVERY")
      ? parked
      : [],
  ),
  count: jest.fn(async () => parked.length),
  findFirst: jest.fn(
    async (args: { where: unknown; select: Record<string, true> }) =>
      parked[0]
        ? Object.fromEntries(
            Object.keys(args.select).map((k) => [
              k,
              parked[0][k as keyof typeof parkedRow],
            ]),
          )
        : null,
  ),
};
const mockDb = {
  payment: mockPayment,
  consultantPayout: mockEmpty(),
  organizationPayout: mockEmpty(),
  organizationInvoice: mockEmpty(),
  dispute: mockEmpty(),
  webhookEvent: mockEmpty(),
  failedEmail: mockEmpty(),
  notificationOutbox: mockEmpty(),
  // The single gauge statement's row.
  $queryRaw: jest.fn(async () => [
    {
      refundsOwed: 0,
      payoutsStuck: 0,
      dunningNotices: 0,
      disputesDue: 0,
      webhookEvents: 0,
      emailRetries: 0,
      notificationRetries: 0,
    },
  ]),
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));

import { readPendingAges } from "@/lib/cron/pending-ages";
import { readNeedsAttention } from "@/lib/backoffice/needs-attention";
import {
  emitTelemetryLog,
  type PendingAges,
} from "@/lib/observability/betterstack-telemetry";

/** The `oldestPendingAgeS` the Better Stack summary line carries for these gauges. */
async function summaryGauges(ages: PendingAges) {
  const sent = jest.fn(async (..._a: unknown[]) => new Response(null));
  process.env.ENABLE_BETTERSTACK_TELEMETRY = "true";
  process.env.BETTERSTACK_SOURCE_TOKEN = "token";
  process.env.BETTERSTACK_INGEST_URL = "https://ingest.test";
  expect(
    await emitTelemetryLog(
      {
        level: "info",
        message: "cron-tick summary",
        category: "CRON",
        oldestPendingAgeS: ages,
      },
      sent as unknown as typeof fetch,
    ),
  ).toBe("sent");
  const init = sent.mock.calls[0][1] as { body: string };
  return JSON.parse(init.body).oldestPendingAgeS;
}

const ENV = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = ENV;
  jest.restoreAllMocks();
});

it("carries the age of the queue's first row, read through the queue's own where", async () => {
  parked = [parkedRow];
  const ages = await readPendingAges(mockDb as never, NOW);
  const queue = (await readNeedsAttention(NOW)).find(
    (q) => q.key === "parkedCaptures",
  );

  expect(ages.parkedCaptures).toBe(90);
  expect(queue?.items?.oldest[0]).toMatchObject({ id: parkedRow.id });
  expect(Math.round((queue?.items?.oldest[0].ageMs ?? 0) / SEC)).toBe(
    ages.parkedCaptures,
  );
  const pageWhere = mockPayment.findMany.mock.calls
    .map((call) => call[0].where)
    .find((w) => JSON.stringify(w).includes("REQUIRES_MANUAL_RECOVERY"));
  expect(mockPayment.findFirst.mock.calls[0][0].where).toBe(pageWhere);
  expect(await summaryGauges(ages)).toMatchObject({ parkedCaptures: 90 });
});

it("is 0 when nothing is parked", async () => {
  parked = [];
  const ages = await readPendingAges(mockDb as never, NOW);

  expect(ages.parkedCaptures).toBe(0);
  expect(await summaryGauges(ages)).toMatchObject({ parkedCaptures: 0 });
});
