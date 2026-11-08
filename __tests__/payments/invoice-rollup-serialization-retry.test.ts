/**
 * @jest-environment node
 */

/**
 * #1347 — a serialization abort used to cost an org a whole billing cycle.
 *
 * The rollup runs Serializable so two concurrent runs can't both issue an
 * invoice for the same accruals. The loser aborts with P2034, and the cron
 * treated every P2034 as a benign skip: "an overlapping run claimed this org".
 * That reading only holds when the rival was a same-org rollup. Postgres also
 * aborts on a read-write dependency with an unrelated writer touching Payment
 * or OverageEvent, and there the org simply went unbilled until the next
 * monthly run, with a console.log as its only trace.
 *
 * These pin the two halves of the fix: the abort is retried before it is
 * believed, and an exhausted retry is reported rather than swallowed.
 */

// Priced and invoiced as a GST-registered platform (Haryana, the registered office).
process.env.PLATFORM_GSTIN = "06AAFCF1234Q1ZN";

const mockTransaction = jest.fn();
const mockOrgFindUnique = jest.fn();
const mockOrgCandidates = jest.fn();
const mockRecordSystemError = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: (...a: unknown[]) => mockTransaction(...a),
    organization: {
      findUnique: (...a: unknown[]) => mockOrgFindUnique(...a),
      findMany: (...a: unknown[]) => mockOrgCandidates(...a),
    },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/enterprise/system-events", () => {
  return {
    recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
    recordSystemErrorSafe: (...a: unknown[]) => mockRecordSystemError(...a),
  };
});

jest.mock("../../lib/maintenance-cron", () => ({
  abortIfMaintenance: jest.fn(),
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

jest.mock("../../lib/payments/billing/invoice-numbering", () => ({
  generateOrgInvoiceNumber: jest
    .fn()
    .mockResolvedValue({ invoiceNumber: "ACME/26-27/1", fiscalYear: "26-27" }),
}));

// #1744 row 2 — the issued-invoice bell and webhook are staged on the tx.
const mockNotifyIssued = jest.fn();
const mockDispatchWebhook = jest.fn();
const mockAttemptTrigger = jest.fn();
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoiceIssued: (...a: unknown[]) => mockNotifyIssued(...a),
}));
jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: (...a: unknown[]) => mockDispatchWebhook(...a),
}));
jest.mock("../../lib/novu", () => ({
  attemptTrigger: (...a: unknown[]) => mockAttemptTrigger(...a),
}));
jest.mock("../../lib/url", () => ({ getAppUrl: () => "https://app.test" }));

import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import { rollupOrgInvoiceAccruals } from "@/lib/payments/billing/invoice-rollup";
import { settleInvoiceAccruals } from "@/jobs/billing/settle-invoice-accruals";

function p2034() {
  return new Prisma.PrismaClientKnownRequestError("write conflict", {
    code: "P2034",
    clientVersion: "test",
  });
}

/** The rollup transaction's return shape: the public result plus staged bells. */
function invoice(id: string) {
  return {
    result: {
      invoiceId: id,
      invoiceNumber: `ACME/26-27/${id}`,
      billedPaymentCount: 2,
      subtotalPaise: 500000,
      totalPaise: 590000,
    },
    notifyStaged: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ENABLE_CONSOLIDATED_INVOICE;
  mockOrgFindUnique.mockResolvedValue({
    id: "org_1",
    name: "Acme",
    slug: "acme",
    status: "ACTIVE",
    deletedAt: null,
    invoiceNumberPrefix: null,
    billingAccountId: "ba_1",
    dataResidencyRegion: "IN",
    paymentTermsDays: 30,
    taxInfo: { gstStateCode: "06", gstin: null, hsnDefault: null },
  });
  mockNotifyIssued.mockResolvedValue([{ id: "ob_1" }]);
  mockDispatchWebhook.mockResolvedValue({ enqueuedCount: 1 });
  mockAttemptTrigger.mockResolvedValue({ outcome: "SENT" });
});

/** A committed-looking tx double for the issue path. */
function issuingTx(opts: {
  payments?: Array<{
    id: string;
    taxAmount: number;
    legs: Array<{ amountPaise: number }>;
  }>;
  overageEvents?: Array<{
    id: string;
    bookingUtilization: { paymentId: string };
  }>;
}) {
  const overageFindMany = jest.fn(
    async (_args: unknown) => opts.overageEvents ?? [],
  );
  const overageUpdateMany = jest.fn(async (_args: unknown) => ({ count: 1 }));
  const invoiceCreate = jest.fn().mockResolvedValue({ id: "inv_9" });
  const tx = {
    payment: {
      // Tax-inclusive, as the leg-sum trigger forces: ₹10 base + ₹1.80 GST.
      findMany: async () =>
        opts.payments ?? [
          { id: "pay_1", taxAmount: 180, legs: [{ amountPaise: 1180 }] },
        ],
      updateMany: async () => ({ count: 1 }),
    },
    organizationInvoice: { create: invoiceCreate },
    invoiceLineItem: { findMany: async () => [] },
    overageEvent: { findMany: overageFindMany, updateMany: overageUpdateMany },
    purchaseOrder: { findMany: async () => [] },
  };
  return { tx, invoiceCreate, overageFindMany, overageUpdateMany };
}

describe("rollupOrgInvoiceAccruals — serialization retry", () => {
  it("retries a P2034 and issues exactly one invoice", async () => {
    // The first attempt loses the race; the second commits.
    mockTransaction
      .mockRejectedValueOnce(p2034())
      .mockResolvedValueOnce(invoice("inv_1"));

    const result = await rollupOrgInvoiceAccruals({ organizationId: "org_1" });

    expect(result.invoiceId).toBe("inv_1");
    // Two attempts, one committed invoice — a retry must not double-bill.
    expect(mockTransaction).toHaveBeenCalledTimes(2);
  });
});

describe("settleInvoiceAccruals — exhausted retries", () => {
  it("records a system error and still bills the next org", async () => {
    mockOrgCandidates.mockResolvedValue([
      { id: "org_contended" },
      { id: "org_ok" },
    ]);
    // withSerializableRetry burns its four attempts on the first org, then the
    // second org commits on its first try.
    mockTransaction
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockResolvedValueOnce(invoice("inv_2"));

    const r = await settleInvoiceAccruals();

    expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
    expect(mockRecordSystemError.mock.calls[0][0]).toMatchObject({
      organizationId: "org_contended",
      category: "INVOICE",
    });
    // The contended org is skipped, not fatal: the next org is still invoiced.
    expect(r.invoicesCreated).toBe(1);
  });
});

// The rollup reads the supplier state from PLATFORM_GSTIN, like the B2C mint.
describe("rollupOrgInvoiceAccruals — supplier state", () => {
  const OLD_ENV = process.env;
  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("writes the GSTIN's state", async () => {
    process.env = { ...OLD_ENV, PLATFORM_GSTIN: "06AAFCF1234Q1ZN" };
    const invoiceCreate = jest.fn().mockResolvedValue({ id: "inv_9" });
    mockTransaction.mockImplementation(async (fn) =>
      fn({
        payment: {
          findMany: async () => [
            { id: "pay_1", taxAmount: 180, legs: [{ amountPaise: 1180 }] },
          ],
          updateMany: async () => ({ count: 1 }),
        },
        organizationInvoice: { create: invoiceCreate },
        invoiceLineItem: { findMany: async () => [] },
        overageEvent: { findMany: async () => [] },
        purchaseOrder: { findMany: async () => [] },
      }),
    );

    await rollupOrgInvoiceAccruals({ organizationId: "org_1" });

    // Buyer state 06 matches the GSTIN-derived supplier state: intra-state.
    expect(invoiceCreate.mock.calls[0][0].data).toMatchObject({
      placeOfSupply: "06",
      cgstPaise: 90,
      sgstPaise: 90,
    });
  });
});

// #1744 row 2 — a rollup invoice used to issue silently: no owner bell, no
// `invoice.issued` webhook. Both are staged on the rollup transaction and the
// bell is attempted after the commit; an EMPTY run stages nothing.
describe("rollupOrgInvoiceAccruals — issued-invoice notice + webhook", () => {
  it("stages one bell and one outbound row per issued invoice, then attempts the bell", async () => {
    const { tx } = issuingTx({});
    mockTransaction.mockImplementation(async (fn) => fn(tx));

    const r = await rollupOrgInvoiceAccruals({ organizationId: "org_1" });

    expect(r.invoiceId).toBe("inv_9");
    expect(mockNotifyIssued).toHaveBeenCalledTimes(1);
    expect(mockNotifyIssued.mock.calls[0][2]).toMatchObject({
      tx,
      entityRef: "orgInvoice:inv_9",
    });
    expect(mockDispatchWebhook).toHaveBeenCalledTimes(1);
    expect(mockDispatchWebhook.mock.calls[0][0]).toMatchObject({
      prisma: tx,
      eventType: "invoice.issued",
      payload: { invoiceId: "inv_9" },
    });
    expect(mockAttemptTrigger).toHaveBeenCalledWith({ id: "ob_1" });
  });

  it("stages nothing on an EMPTY run", async () => {
    const { tx } = issuingTx({ payments: [] });
    mockTransaction.mockImplementation(async (fn) => fn(tx));

    const r = await rollupOrgInvoiceAccruals({ organizationId: "org_1" });

    expect(r.invoiceId).toBeNull();
    expect(mockNotifyIssued).not.toHaveBeenCalled();
    expect(mockDispatchWebhook).not.toHaveBeenCalled();
    expect(mockAttemptTrigger).not.toHaveBeenCalled();
  });

  // #1744 row 6 — a wound-down org is never billed again.
  it("returns EMPTY for a DEACTIVATED org without opening a transaction", async () => {
    mockOrgFindUnique.mockResolvedValue({
      id: "org_1",
      name: "Acme",
      slug: "acme",
      status: "DEACTIVATED",
      deletedAt: new Date(),
      invoiceNumberPrefix: null,
      billingAccountId: "ba_1",
      dataResidencyRegion: "IN",
      paymentTermsDays: 30,
      taxInfo: null,
    });

    const r = await rollupOrgInvoiceAccruals({ organizationId: "org_1" });

    expect(r.invoiceId).toBeNull();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

// #1744 row 6 (P1) — only a PENDING CHARGE_ORG event can move to ACCRUED; the
// read used to pull FAILED/REVERSED rows too and report each as an orphan.
describe("rollupOrgInvoiceAccruals — overage chargeStatus filter", () => {
  it("reads only PENDING CHARGE_ORG events and moves them to ACCRUED", async () => {
    const { tx, overageFindMany, overageUpdateMany } = issuingTx({
      overageEvents: [
        { id: "ev_1", bookingUtilization: { paymentId: "pay_1" } },
      ],
    });
    mockTransaction.mockImplementation(async (fn) => fn(tx));

    await rollupOrgInvoiceAccruals({ organizationId: "org_1" });

    expect(overageFindMany.mock.calls[0][0]).toMatchObject({
      where: { overageBehavior: "CHARGE_ORG", chargeStatus: "PENDING" },
    });
    expect(overageUpdateMany).toHaveBeenCalledTimes(1);
    expect(overageUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "ev_1" },
      data: { chargeStatus: "ACCRUED" },
    });
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });
});

// #1744 row 3 — the buyer GSTIN's first two digits pick the tax head even when
// the org never filled `gstStateCode`; existing orgs are right on their next
// invoice with no backfill.
describe("rollupOrgInvoiceAccruals — buyer GSTIN drives the tax head", () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, PLATFORM_GSTIN: "06AAFCF1234Q1ZN" };
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  // The leg already carries its 180p of GST; the invoice splits it, never adds more.
  it.each([
    ["06AAAAA0000A1Z5", { cgstPaise: 90, sgstPaise: 90, igstPaise: 0 }],
    ["27AAAAA0000A1Z5", { cgstPaise: 0, sgstPaise: 0, igstPaise: 180 }],
  ])("GSTIN %s with a null state", async (gstin, heads) => {
    mockOrgFindUnique.mockResolvedValue({
      id: "org_1",
      name: "Acme",
      slug: "acme",
      status: "ACTIVE",
      deletedAt: null,
      invoiceNumberPrefix: null,
      billingAccountId: "ba_1",
      dataResidencyRegion: "IN",
      paymentTermsDays: 30,
      taxInfo: { gstStateCode: null, gstin, hsnDefault: null },
    });
    const { tx, invoiceCreate } = issuingTx({});
    mockTransaction.mockImplementation(async (fn) => fn(tx));

    await rollupOrgInvoiceAccruals({ organizationId: "org_1" });

    expect(invoiceCreate.mock.calls[0][0].data).toMatchObject({
      ...heads,
      placeOfSupply: gstin.slice(0, 2),
      subtotalPaise: 1000,
      totalPaise: 1180,
    });
  });

  it("skips a domestic org with neither a GST state nor a GSTIN", async () => {
    mockOrgFindUnique.mockResolvedValue({
      id: "org_1",
      name: "Acme",
      slug: "acme",
      status: "ACTIVE",
      deletedAt: null,
      invoiceNumberPrefix: null,
      billingAccountId: "ba_1",
      dataResidencyRegion: "IN",
      paymentTermsDays: 30,
      taxInfo: null,
    });

    const r = await rollupOrgInvoiceAccruals({ organizationId: "org_1" });

    expect(r).toMatchObject({ invoiceId: null, skippedNoGstState: true });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("rollupOrgInvoiceAccruals — PO coverage", () => {
  it("holds a requiresPO org's rollup as an unannounced DRAFT when no PO covers it", async () => {
    mockOrgFindUnique.mockResolvedValueOnce({
      id: "org_1",
      name: "Acme",
      slug: "acme",
      status: "ACTIVE",
      deletedAt: null,
      invoiceNumberPrefix: null,
      billingAccountId: "ba_1",
      dataResidencyRegion: "IN",
      paymentTermsDays: 30,
      requiresPO: true,
      taxInfo: { gstStateCode: "06", gstin: null, hsnDefault: null },
    });
    const { tx, invoiceCreate } = issuingTx({});
    mockTransaction.mockImplementation(async (fn) => fn(tx));

    const r = await rollupOrgInvoiceAccruals({ organizationId: "org_1" });

    expect(r.heldForPo).toBe(true);
    expect(invoiceCreate.mock.calls[0][0].data).toMatchObject({
      status: "DRAFT",
      issuedAt: null,
      purchaseOrderId: null,
    });
    expect(mockNotifyIssued).not.toHaveBeenCalled();
    expect(mockDispatchWebhook).not.toHaveBeenCalled();
  });
});

test("bounded invoice rollup counts skipped organizations against the examination limit", async () => {
  mockOrgCandidates.mockResolvedValue([
    { id: "org_1" },
    { id: "org_2" },
    { id: "org_3" },
  ]);
  mockTransaction.mockResolvedValue({
    result: { billedPaymentCount: 0, totalPaise: 0 },
    notifyStaged: [],
  });
  const result = await settleInvoiceAccruals({ limit: 2 });
  expect(result).toMatchObject({
    orgsProcessed: 2,
    invoicesCreated: 0,
    remaining: 1,
  });
  expect(mockTransaction).toHaveBeenCalledTimes(2);
  expect(mockOrgCandidates).toHaveBeenCalledWith(
    expect.objectContaining({
      take: 3,
      where: expect.objectContaining({
        status: { not: "DEACTIVATED" },
        deletedAt: null,
      }),
    }),
  );
});

test("skipped invoice cohorts rotate so later organizations are examined", async () => {
  const orgs = Array.from({ length: 25 }, (_, i) => ({
    id: `org_${String(i).padStart(2, "0")}`,
    lastAccrualRollupAt: null as Date | null,
  }));
  mockOrgCandidates.mockImplementation(async ({ take }: { take: number }) =>
    [...orgs]
      .sort(
        (a, b) =>
          (a.lastAccrualRollupAt?.getTime() ?? 0) -
            (b.lastAccrualRollupAt?.getTime() ?? 0) || (a.id < b.id ? -1 : 1),
      )
      .slice(0, take),
  );
  const stamp = prisma.$executeRaw as jest.Mock;
  stamp.mockImplementation(async (_sql: TemplateStringsArray, id: string) => {
    const org = orgs.find((o) => o.id === id);
    if (org) org.lastAccrualRollupAt = new Date();
    return 1;
  });
  mockTransaction.mockResolvedValue({
    result: { billedPaymentCount: 0, totalPaise: 0 },
    notifyStaged: [],
  });
  for (let i = 0; i < 3; i++) await settleInvoiceAccruals({ limit: 10 });
  expect(new Set(stamp.mock.calls.map(([, id]) => id)).size).toBe(25);
  expect(stamp).toHaveBeenCalledTimes(30);
  stamp.mockResolvedValue(1);
});

test("a cursor failure is visible without discarding successful invoices or later organizations", async () => {
  mockOrgCandidates.mockResolvedValue([{ id: "org_1" }, { id: "org_2" }]);
  mockTransaction.mockResolvedValue(invoice("invoice-issued"));
  const stamp = jest.mocked(prisma.$executeRaw);
  stamp
    .mockRejectedValueOnce(new Error("cursor unavailable"))
    .mockResolvedValue(1);

  const result = await settleInvoiceAccruals();
  expect(result).toMatchObject({
    orgsProcessed: 2,
    invoicesCreated: 2,
    failed: 1,
  });
  expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
  expect(mockRecordSystemError.mock.calls[0][0]).toMatchObject({
    organizationId: "org_1",
    context: {
      failures: [{ organizationId: "org_1", phase: "cursor", code: null }],
    },
  });
  expect(stamp.mock.calls[0][0]).toEqual(
    expect.arrayContaining([expect.stringContaining('UPDATE "organizations"')]),
  );
});

test("a multi-organization failure reports once and still invoices the next organization", async () => {
  mockOrgCandidates.mockResolvedValue([
    { id: "org_bad_1" },
    { id: "org_bad_2" },
    { id: "org_ok" },
  ]);
  mockTransaction
    .mockRejectedValueOnce(new Error("first failure"))
    .mockRejectedValueOnce(new Error("second failure"))
    .mockResolvedValueOnce(invoice("invoice-ok"));
  const result = await settleInvoiceAccruals();
  expect(result).toMatchObject({
    orgsProcessed: 3,
    invoicesCreated: 1,
    failed: 2,
  });
  expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
  expect(mockRecordSystemError.mock.calls[0][0]).toMatchObject({
    context: { organizations: ["org_bad_1", "org_bad_2"] },
  });
});
