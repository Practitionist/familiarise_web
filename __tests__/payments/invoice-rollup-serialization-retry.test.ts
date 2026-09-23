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

const mockTransaction = jest.fn();
const mockOrgFindUnique = jest.fn();
const mockPaymentFindMany = jest.fn();
const mockRecordSystemError = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (...a: unknown[]) => mockTransaction(...a),
    organization: { findUnique: (...a: unknown[]) => mockOrgFindUnique(...a) },
    payment: { findMany: (...a: unknown[]) => mockPaymentFindMany(...a) },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
}));

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
    taxInfo: null,
  });
  mockNotifyIssued.mockResolvedValue([{ id: "ob_1" }]);
  mockDispatchWebhook.mockResolvedValue({ enqueuedCount: 1 });
  mockAttemptTrigger.mockResolvedValue({ outcome: "SENT" });
});

/** A committed-looking tx double for the issue path. */
function issuingTx(opts: {
  payments?: Array<{ id: string; legs: Array<{ amountPaise: number }> }>;
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
      findMany: async () =>
        opts.payments ?? [{ id: "pay_1", legs: [{ amountPaise: 1000 }] }],
      updateMany: async () => ({ count: 1 }),
    },
    organizationInvoice: { create: invoiceCreate },
    invoiceLineItem: { findMany: async () => [] },
    overageEvent: { findMany: overageFindMany, updateMany: overageUpdateMany },
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
    mockPaymentFindMany.mockResolvedValue([
      { organizationId: "org_contended" },
      { organizationId: "org_ok" },
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

// #1447 — the rollup read SUPPLIER_STATE_CODE ?? "KA" while the B2C mint was
// GSTIN-first; with only PLATFORM_GSTIN set the invoice must carry its state.
describe("rollupOrgInvoiceAccruals — supplier state", () => {
  const OLD_ENV = process.env;
  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("writes the GSTIN's state when SUPPLIER_STATE_CODE is unset", async () => {
    process.env = { ...OLD_ENV, PLATFORM_GSTIN: "29AAFCF1234Q1ZN" };
    delete process.env.SUPPLIER_STATE_CODE;
    const invoiceCreate = jest.fn().mockResolvedValue({ id: "inv_9" });
    mockTransaction.mockImplementation(async (fn) =>
      fn({
        payment: {
          findMany: async () => [
            { id: "pay_1", legs: [{ amountPaise: 1000 }] },
          ],
          updateMany: async () => ({ count: 1 }),
        },
        organizationInvoice: { create: invoiceCreate },
        invoiceLineItem: { findMany: async () => [] },
        overageEvent: { findMany: async () => [] },
      }),
    );

    await rollupOrgInvoiceAccruals({ organizationId: "org_1" });

    expect(invoiceCreate.mock.calls[0][0].data.placeOfSupply).toBe("29");
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
    process.env = { ...OLD_ENV, PLATFORM_GSTIN: "29AAFCF1234Q1ZN" };
    delete process.env.SUPPLIER_STATE_CODE;
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  it.each([
    ["29AAAAA0000A1Z5", { cgstPaise: 90, sgstPaise: 90, igstPaise: 0 }],
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
    });
  });
});
