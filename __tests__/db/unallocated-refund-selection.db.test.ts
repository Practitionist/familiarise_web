import { Client } from "pg";
import { Prisma } from "@prisma/client";
import { assertDisposableDatabase } from "./guard";

let mockClient: Client;
const mockDrive = jest.fn(async (..._args: unknown[]) => ({ kind: "settled" }));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    consultation: { findMany: async () => [] },
    subscription: { findMany: async () => [] },
    appointment: { findMany: async () => [] },
    appointmentOccurrence: { findMany: async () => [] },
    payment: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    bookingStatusHistory: { findMany: async () => [] },
    windowBackupInterest: { updateMany: async () => ({ count: 0 }) },
    $queryRaw: async (query: Prisma.Sql) =>
      (await mockClient.query(query.text, [...query.values])).rows,
    $executeRaw: async (query: Prisma.Sql) =>
      (await mockClient.query(query.text, [...query.values])).rowCount,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      await mockClient.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      try {
        const result = await fn(db);
        await mockClient.query("COMMIT");
        return result;
      } catch (error) {
        await mockClient.query("ROLLBACK");
        throw error;
      }
    },
    $disconnect: async () => undefined,
  };
  return { __esModule: true, default: db };
});
jest.mock("../../lib/payments/operations/refund-owed", () => ({
  ...jest.requireActual<
    typeof import("../../lib/payments/operations/refund-owed")
  >("../../lib/payments/operations/refund-owed"),
  driveRefundOwed: (...args: unknown[]) => mockDrive(...args),
}));
jest.mock("../../lib/payments/operations/refund", () => ({}));
jest.mock("../../lib/booking/backup-interest", () => ({
  expireBackupInterest: async () => ({ count: 0 }),
}));
jest.mock("../../lib/booking/expiry-notices", () => ({}));
jest.mock("../../lib/novu/service", () => ({}));
jest.mock("../../lib/novu/outbox", () => ({}));
jest.mock("../../lib/novu/stage-bell", () => ({}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({}));
jest.mock("../../lib/email", () => ({ EMAIL_BUDGET_MS: { JOB: 1 } }));
jest.mock("../../lib/email/senders/booking", () => ({}));

import { expireStaleRequests } from "../../scripts/appointments/expire-stale-requests";
import { refundableBalancePaise } from "../../lib/payments/refundable-balance";
import { refundableBalancePaiseSql } from "../../lib/payments/refundable-balance-sql";

function physicalName(modelName: string, fieldName?: string): string {
  const model = Prisma.dmmf.datamodel.models.find(
    (item) => item.name === modelName,
  );
  if (!model) throw new Error(`Missing fixture model ${modelName}`);
  if (fieldName === undefined) return `"${model.dbName ?? model.name}"`;
  const field = model.fields.find((item) => item.name === fieldName);
  if (!field)
    throw new Error(`Missing fixture field ${modelName}.${fieldName}`);
  return `"${field.dbName ?? field.name}"`;
}

beforeAll(async () => {
  assertDisposableDatabase();
  mockClient = new Client({ connectionString: process.env.DATABASE_URL });
  await mockClient.connect();
  // Derive physical identifiers from Prisma's schema metadata. A fixture using
  // logical field names would hide raw SQL mistakes on @map/@@map fields.
  const fixtures: Record<string, Record<string, string>> = {
    Subscription: {
      id: "text PRIMARY KEY",
      status: "text",
    },
    Appointment: {
      id: "text PRIMARY KEY",
      subscriptionId: "text",
    },
    BookingStatusHistory: {
      entityId: "text",
      entity: "text",
      reason: "text",
      toStatus: "text",
      createdAt: "timestamptz",
    },
    Payment: {
      id: "text PRIMARY KEY",
      amount: "bigint",
      paymentIntent: "text",
      paymentStatus: "text DEFAULT 'SUCCEEDED'",
      appointmentId: "text",
      deletedAt: "timestamptz",
      createdAt: "timestamptz DEFAULT now()",
      updatedAt: "timestamptz DEFAULT now()",
      refundOwedKey: "text UNIQUE",
      refundOwedPaise: "bigint",
      refundOwedReason: "text",
      refundOwedAt: "timestamptz",
      refundOwedAttempts: "int DEFAULT 0",
    },
    Refund: {
      paymentId: "text",
      dedupeKey: "text",
      amountPaise: "bigint",
      status: "text",
    },
    Dispute: {
      paymentId: "text",
      amountPaise: "bigint",
      status: "text",
    },
  };
  await mockClient.query(
    Object.entries(fixtures)
      .map(
        ([model, columns]) =>
          `CREATE TEMP TABLE ${physicalName(model)} (${Object.entries(columns)
            .map(([field, ddl]) => `${physicalName(model, field)} ${ddl}`)
            .join(", ")})`,
      )
      .join(";"),
  );
});
afterAll(async () => {
  await mockClient?.end();
});
beforeEach(async () => {
  mockDrive.mockClear();
  await mockClient.query(
    'TRUNCATE "Subscription", "Appointment", "BookingStatusHistory", "Payment", "Refund", "Dispute"',
  );
});

async function plan(id: string, intent = "pay_card", age = 40) {
  await mockClient.query('INSERT INTO "Subscription" VALUES ($1, $2)', [
    id,
    "EXPIRED",
  ]);
  await mockClient.query('INSERT INTO "Appointment" VALUES ($1, $2)', [
    `a-${id}`,
    id,
  ]);
  await mockClient.query(
    "INSERT INTO \"BookingStatusHistory\" VALUES ($1, $2, $3, $4, now() - interval '40 days')",
    [id, "SUBSCRIPTION", "UNALLOCATED_48H", "EXPIRED"],
  );
  await mockClient.query(
    'INSERT INTO "Payment" (id, amount, "paymentIntent", "appointmentId", "createdAt") VALUES ($1, 10000, $2, $3, now() - $4 * interval \'1 day\')',
    [id, intent, `a-${id}`, age],
  );
}
async function refund(
  id: string,
  amount: number,
  status: string,
  key: string | null = null,
) {
  await mockClient.query('INSERT INTO "Refund" VALUES ($1, $2, $3, $4)', [
    id,
    key,
    amount,
    status,
  ]);
}
async function marked() {
  return (
    await mockClient.query<{ id: string }>(
      'SELECT id FROM "Payment" WHERE "refundOwedKey" = \'sub-unalloc:\' || id ORDER BY id',
    )
  ).rows.map((r) => r.id);
}

it("excludes spent/settled/prior-marker heads before LIMIT and recovers an older-than-14-day liability", async () => {
  for (const id of ["01-spent", "02-settled", "03-claimed", "04-owed"])
    await plan(id);
  await refund("01-spent", 5000, "SUCCEEDED", "sub-unalloc:01-spent");
  await refund("02-settled", 10000, "SUCCEEDED", "other-key");
  await mockClient.query(
    'UPDATE "Payment" SET "refundOwedKey" = $1, "refundOwedAttempts" = 3 WHERE id = $2',
    ["other-door", "03-claimed"],
  );
  const result = await expireStaleRequests({ limits: { maxRequests: 1 } });
  expect(result.success).toBe(true);
  expect(await marked()).toEqual(["04-owed"]);
  const prior = await mockClient.query(
    'SELECT "refundOwedKey", "refundOwedAttempts" FROM "Payment" WHERE id = $1',
    ["03-claimed"],
  );
  expect(prior.rows[0]).toEqual({
    refundOwedKey: "other-door",
    refundOwedAttempts: 3,
  });
});

it("gets past a recent spent history head before applying the payment cap", async () => {
  await plan("01-spent");
  await plan("02-owed");
  await mockClient.query(
    'UPDATE "BookingStatusHistory" SET "createdAt" = now()',
  );
  await refund("01-spent", 10000, "SUCCEEDED", "sub-unalloc:01-spent");
  await expireStaleRequests({ limits: { maxRequests: 1 } });
  expect(await marked()).toEqual(["02-owed"]);
});

it("keeps partial and failed/cancelled refunds eligible, and drains subsequent payment pages", async () => {
  for (const id of ["a", "b", "c"]) await plan(id);
  await refund("a", 2500, "SUCCEEDED");
  await refund("b", 10000, "FAILED", "sub-unalloc:b");
  await refund("c", 10000, "CANCELLED", "sub-unalloc:c");
  const first = await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(first.unallocatedHasMore).toBe(true);
  expect(await marked()).toEqual(["a", "b"]);
  await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(await marked()).toEqual(["a", "b", "c"]);
});

it("handles zero-paise credits by restoration evidence instead of amount > 0", async () => {
  await plan("credit-owed", "free_new");
  await plan("credit-restored", "free_old");
  await mockClient.query('UPDATE "Payment" SET amount = 0');
  await refund("credit-restored", 0, "SUCCEEDED", "prior-restoration");
  await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(await marked()).toEqual(["credit-owed"]);
});

it("does not multiply duplicate history or backfill an active/unproven booking", async () => {
  for (const id of ["a", "b", "c"]) await plan(id);
  await mockClient.query(
    'INSERT INTO "BookingStatusHistory" SELECT * FROM "BookingStatusHistory" WHERE "entityId" = $1',
    ["a"],
  );
  await mockClient.query(
    `UPDATE ${physicalName("Subscription")} SET ${physicalName("Subscription", "status")} = $1 WHERE id = $2`,
    ["PENDING", "b"],
  );
  await mockClient.query(
    'UPDATE "BookingStatusHistory" SET reason = $1 WHERE "entityId" = $2',
    ["OTHER_EXPIRY", "c"],
  );
  await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(await marked()).toEqual(["a"]);
});

it("does not restamp once a differently keyed full refund has settled", async () => {
  await plan("a");
  await expireStaleRequests({ limits: { maxRequests: 1 } });
  await refund("a", 10000, "SUCCEEDED", "operator-refund");
  await mockClient.query('UPDATE "Payment" SET "refundOwedKey" = NULL');
  await expireStaleRequests({ limits: { maxRequests: 1 } });
  expect(await marked()).toEqual([]);
  expect(mockDrive).toHaveBeenCalledTimes(1);
});

it.each(["SUCCEEDED", "PENDING", "FAILED", "CANCELLED"])(
  "SQL balance agrees with centralized arithmetic for %s refunds and returned disputes",
  async (status) => {
    await plan("a");
    await refund("a", 2500, status);
    await mockClient.query(
      'INSERT INTO "Dispute" VALUES ($1, 3000, $2), ($1, 4000, $3)',
      ["a", "LOST", "UNDER_REVIEW"],
    );
    const sql = Prisma.sql`SELECT ${refundableBalancePaiseSql(Prisma.sql`p.id`, Prisma.sql`p.amount`)} AS balance FROM "Payment" p WHERE p.id = 'a'`;
    const actual = await mockClient.query<{ balance: string }>(sql.text, [
      ...sql.values,
    ]);
    expect(Number(actual.rows[0].balance)).toBe(
      refundableBalancePaise(10000, {
        refunds: [{ amountPaise: 2500, status }],
        disputes: [
          { amountPaise: 3000, status: "LOST" },
          { amountPaise: 4000, status: "UNDER_REVIEW" },
        ],
      }),
    );
  },
);
