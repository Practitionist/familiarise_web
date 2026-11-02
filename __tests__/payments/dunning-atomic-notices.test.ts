/** @jest-environment node */

// Overdue notices are outbox rows written inside the winning claim's
// transaction: a rollback takes them, a lost claim stages none.

type Row = { key: string; channel: "bell" | "email" };

const mockFindMany = jest.fn();
const mockRoster = jest.fn();
const mockAttemptTrigger = jest.fn();
const mockAttemptStaged = jest.fn();
let mockOutbox: Row[] = [];
let mockPending: Row[] = [];
const mockTx = {
  organizationInvoice: { updateMany: jest.fn() },
  orgAuditLog: { create: jest.fn(async () => ({})) },
};
const mockTransaction = jest.fn(
  async (run: (tx: typeof mockTx) => Promise<unknown>) => {
    mockPending = [];
    const result = await run(mockTx);
    for (const row of mockPending) {
      if (!mockOutbox.some((r) => r.key === row.key)) mockOutbox.push(row);
    }
    return result;
  },
);
const mockNotify = jest.fn(
  async (
    _orgId: string,
    _payload: unknown,
    opts: { tx: unknown; dedupeKey: string },
  ) => {
    if (opts.tx !== mockTx) throw new Error("bell staged outside the claim");
    mockPending.push({ key: opts.dedupeKey, channel: "bell" });
    return [{ id: opts.dedupeKey }];
  },
);
const mockStageEmail = jest.fn(
  async (tx: unknown, args: { invoiceId: string; reminderStage: number }) => {
    if (tx !== mockTx) throw new Error("email staged outside the claim");
    const key = `email:${args.invoiceId}:${args.reminderStage}`;
    mockPending.push({ key, channel: "email" });
    return [{ staged: { id: key } }];
  },
);

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    organizationInvoice: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
    $transaction: (run: (tx: typeof mockTx) => Promise<unknown>) =>
      mockTransaction(run),
  },
}));
jest.mock("@/lib/feature-flags", () => ({ ENABLE_DUNNING_SUSPEND: true }));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _options: unknown, run: () => unknown) => run(),
}));
jest.mock("@/lib/db/serializable-retry", () => ({
  withSerializableRetry: (run: () => unknown) => run(),
}));
jest.mock("@/lib/payments/core/razorpay", () => ({
  readRazorpayOrderHolding: jest.fn(async () => ({ kind: "empty" })),
}));
jest.mock("@/lib/payments/billing/org-invoice-settlement", () => ({
  applyOrgInvoiceCapture: jest.fn(),
  invoiceOutstandingPaise: jest.fn(async () => 100_000),
}));
jest.mock("@/lib/novu/org-workflows", () => ({
  notifyOrgInvoiceOverdue: (
    orgId: string,
    payload: unknown,
    opts: { tx: unknown; dedupeKey: string },
  ) => mockNotify(orgId, payload, opts),
  rosterForOrg: (...args: unknown[]) => mockRoster(...args),
  VISIBILITY_ROLES: ["OWNER"],
}));
jest.mock("@/lib/novu/outbox", () => ({
  attemptTrigger: (...args: unknown[]) => mockAttemptTrigger(...args),
}));
jest.mock("@/lib/email", () => ({
  attemptStaged: (...args: unknown[]) => mockAttemptStaged(...args),
  EMAIL_BUDGET_MS: { JOB: 1 },
  MONEY_EMAIL_TYPES: { ORG_INVOICE_OVERDUE: "ORG_INVOICE_OVERDUE" },
  stageOrgInvoiceOverdueEmail: (
    tx: unknown,
    args: { invoiceId: string; reminderStage: number },
  ) => mockStageEmail(tx, args),
}));

import { runDunning } from "@/jobs/billing/dunning";

const invoice = {
  id: "inv-1",
  organizationId: "org-1",
  providerPaymentOrderId: null,
  invoiceNumber: "INV-1",
  totalPaise: 100_000,
  displayCurrency: "INR",
  dueDate: new Date("2026-09-01T00:00:00Z"),
  markedOverdueAt: new Date("2026-09-02T00:00:00Z"),
  lastDunningReminderAt: null,
  dunningReminderCount: 2,
  organization: { name: "Org" },
};

function queue(
  stage1: unknown[],
  stage2: unknown[] = [],
  stage3: unknown[] = [],
) {
  mockFindMany
    .mockResolvedValueOnce(stage1)
    .mockResolvedValueOnce(stage2)
    .mockResolvedValueOnce(stage3);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindMany.mockReset();
  mockOutbox = [];
  mockTx.organizationInvoice.updateMany.mockResolvedValue({ count: 1 });
  mockRoster.mockResolvedValue(["owner-1"]);
  mockAttemptTrigger.mockResolvedValue({ success: true });
  mockAttemptStaged.mockResolvedValue(undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it("stages both notices in the winning OVERDUE transaction, then attempts them", async () => {
  queue([invoice]);

  const stats = await runDunning({ limit: 5 });

  expect(stats).toMatchObject({ markedOverdue: 1, failed: 0 });
  expect(mockRoster).toHaveBeenCalledWith("org-1", ["OWNER"], mockTx);
  expect(mockOutbox).toEqual([
    { key: "orgInvoice:inv-1:overdue:0", channel: "bell" },
    { key: "email:inv-1:0", channel: "email" },
  ]);
  expect(mockAttemptTrigger).toHaveBeenCalledWith({
    id: "orgInvoice:inv-1:overdue:0",
  });
  expect(mockAttemptStaged).toHaveBeenCalledWith(
    [{ staged: { id: "email:inv-1:0" } }],
    "ORG_INVOICE_OVERDUE",
    1,
  );
});

it("stages nothing when the claim loses, so a re-run cannot double-stage", async () => {
  queue([invoice]);
  await runDunning({ limit: 5 });
  mockTx.organizationInvoice.updateMany.mockResolvedValue({ count: 0 });
  queue([invoice]);

  const rerun = await runDunning({ limit: 5 });

  expect(rerun).toMatchObject({ markedOverdue: 0, failed: 0 });
  expect(mockNotify).toHaveBeenCalledTimes(1);
  expect(mockStageEmail).toHaveBeenCalledTimes(1);
  expect(mockOutbox).toHaveLength(2);
});

it("keeps the committed rows for the relays when the inline sends fail", async () => {
  queue([invoice]);
  mockAttemptTrigger.mockRejectedValue(new Error("novu down"));
  mockAttemptStaged.mockRejectedValue(new Error("resend down"));

  const stats = await runDunning({ limit: 5 });

  expect(stats).toMatchObject({ markedOverdue: 1, failed: 0 });
  expect(mockOutbox).toHaveLength(2);
});

it("counts a roster failure and rolls the claim and its bell back", async () => {
  queue([invoice]);
  mockRoster.mockRejectedValue(new Error("roster read failed"));

  const stats = await runDunning({ limit: 5 });

  expect(stats).toMatchObject({ markedOverdue: 0, failed: 1 });
  expect(mockNotify).toHaveBeenCalledTimes(1);
  expect(mockOutbox).toEqual([]);
  expect(mockAttemptTrigger).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining("claim failed for invoice inv-1"),
    expect.any(Error),
  );
});

it("gives the final reminder and the suspension their own notice identities", async () => {
  const suspended = {
    ...invoice,
    id: "inv-2",
    dunningReminderCount: 3,
    lastDunningReminderAt: new Date("2026-09-30T00:00:00Z"),
  };
  queue([], [invoice], [suspended]);

  const stats = await runDunning({ limit: 5 });

  expect(stats).toMatchObject({ remindersSent: 1, suspended: 1, failed: 0 });
  expect(mockOutbox.map((r) => r.key)).toEqual([
    "orgInvoice:inv-1:overdue:3",
    "email:inv-1:3",
    "orgInvoice:inv-2:overdue:4",
    "email:inv-2:4",
  ]);
});
