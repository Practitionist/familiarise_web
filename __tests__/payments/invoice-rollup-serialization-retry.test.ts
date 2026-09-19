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

import { Prisma } from "@prisma/client";
import { rollupOrgInvoiceAccruals } from "@/lib/payments/billing/invoice-rollup";
import { settleInvoiceAccruals } from "@/jobs/billing/settle-invoice-accruals";

function p2034() {
  return new Prisma.PrismaClientKnownRequestError("write conflict", {
    code: "P2034",
    clientVersion: "test",
  });
}

function invoice(id: string) {
  return {
    invoiceId: id,
    invoiceNumber: `ACME/26-27/${id}`,
    billedPaymentCount: 2,
    subtotalPaise: 500000,
    totalPaise: 590000,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ENABLE_CONSOLIDATED_INVOICE;
  mockOrgFindUnique.mockResolvedValue({
    id: "org_1",
    slug: "acme",
    invoiceNumberPrefix: null,
    billingAccountId: "ba_1",
    dataResidencyRegion: "IN",
    paymentTermsDays: 30,
    taxInfo: null,
  });
});

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
