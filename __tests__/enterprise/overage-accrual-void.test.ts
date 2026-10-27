/**
 * @jest-environment node
 */

/**
 * Cancelling a LICENSE booking whose CHARGE_ORG surcharge minted a child accrual
 * per over-cap batch voids each un-invoiced child: a full reversal leg, the exact
 * mirror of its accrual journal, and nothing for the rollup to bill. Runs the real
 * reversal, ledger posting and rollup against in-memory rows.
 */

type Leg = { source: string; amountPaise: number; sourceRef: string | null };
type Child = {
  id: string;
  parentPaymentId: string;
  organizationId: string;
  paymentStatus: string;
  billableToOrgInvoiceId: string | null;
  taxAmount: number;
  legs: Leg[];
};
type Entry = {
  direction: "DEBIT" | "CREDIT";
  amountPaise: number;
  account: { kind: string; organizationId: string | null };
};

const mockRecordSystemEvent = jest.fn(async (_p: unknown) => undefined);
const mockRollupTx: Record<string, unknown> = {};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organization: {
      findUnique: async () => ({
        id: "org-1",
        slug: "org",
        status: "ACTIVE",
        deletedAt: null,
        billingAccountId: "ba-1",
        taxInfo: { gstStateCode: "29", gstin: null, hsnDefault: null },
      }),
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(mockRollupTx),
  },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn(),
  recordSystemEventSafe: (p: unknown) => mockRecordSystemEvent(p),
}));
jest.mock("../../lib/payments/billing/invoice-numbering", () => ({
  generateOrgInvoiceNumber: async () => ({
    invoiceNumber: "ORG/1",
    fiscalYear: "26-27",
  }),
}));
jest.mock("../../lib/payments/billing/purchase-order-draw", () => ({
  drawCoveringPurchaseOrder: async () => null,
}));
jest.mock("../../lib/novu/org-workflows", () => ({}));
jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({}));
jest.mock("../../lib/novu", () => ({}));

import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import { rollupOrgInvoiceAccruals } from "@/lib/payments/billing/invoice-rollup";
import { txDouble } from "../fixtures/tx-double";

const PARENT = "pay-license";
// One batch's accrual: ₹1,000 base + ₹100 surcharge, plus ₹18 GST on the surcharge.
const SURCHARGE = 110_000;
const GST = 1_800;

function world(invoicedChildIds: string[] = []) {
  const children = new Map<string, Child>();
  const events: { id: string; paymentId: string; chargeStatus: string }[] = [];
  const journals = new Map<string, Entry[]>();
  for (const id of ["child-1", "child-2"]) {
    const invoiced = invoicedChildIds.includes(id);
    children.set(id, {
      id,
      parentPaymentId: PARENT,
      organizationId: "org-1",
      paymentStatus: "SUCCEEDED",
      billableToOrgInvoiceId: invoiced ? "inv-1" : null,
      taxAmount: GST,
      legs: [
        {
          source: "OVERAGE_INVOICE_ACCRUAL",
          amountPaise: SURCHARGE + GST,
          sourceRef: "asg-1",
        },
      ],
    });
    events.push({
      id: `ev-${id}`,
      paymentId: id,
      chargeStatus: invoiced ? "ACCRUED" : "PENDING",
    });
    journals.set(`overage-accrual:${id}`, [
      {
        direction: "DEBIT",
        amountPaise: SURCHARGE + GST,
        account: { kind: "ORG_RECEIVABLE", organizationId: "org-1" },
      },
      {
        direction: "CREDIT",
        amountPaise: SURCHARGE,
        account: { kind: "PLATFORM_FEE", organizationId: null },
      },
      {
        direction: "CREDIT",
        amountPaise: GST,
        account: { kind: "GST_PAYABLE", organizationId: null },
      },
    ]);
  }
  const hasReversal = (c: Child) =>
    c.legs.some((l) => l.source === "OVERAGE_INVOICE_ACCRUAL_REVERSAL");
  const accounts = new Map<string, Entry["account"]>();
  // Three one-session batches on a one-engagement seat: two went over cap.
  const ledger = [false, true, true].map((wasOverage) => ({
    engagementsConsumed: 1,
    priceAtBookingPaise: wasOverage ? 0 : 2_360_000,
    wasOverage,
  }));

  const tx = txDouble({
    bookingUtilization: {
      findUnique: jest.fn(async () => ({
        id: "util-1",
        paymentId: PARENT,
        programAssignmentId: "asg-1",
        wasOverage: true,
        programAssignment: {
          membershipId: "mem-1",
          program: { type: "LICENSED_SEAT" },
        },
      })),
      update: jest.fn(async () => ({})),
    },
    usageLedgerEntry: {
      findMany: jest.fn(async () => ledger),
      create: jest.fn(async ({ data }: { data: (typeof ledger)[number] }) =>
        ledger.push(data),
      ),
    },
    programAssignment: { updateMany: jest.fn(async () => ({ count: 1 })) },
    // No member overage holds the parent's earnings here.
    consultantEarnings: { findMany: jest.fn(async () => []) },
    organizationEarnings: { findMany: jest.fn(async () => []) },
    overageEvent: {
      findMany: jest.fn(
        async ({ where }: { where: { chargeStatus: { in: string[] } } }) =>
          events
            .filter((e) => where.chargeStatus.in.includes(e.chargeStatus))
            .map((e) => ({ paymentId: e.paymentId })),
      ),
      updateMany: jest.fn(
        async ({ where }: { where: { chargeStatus: { in: string[] } } }) => {
          const hit = events.filter((e) =>
            where.chargeStatus.in.includes(e.chargeStatus),
          );
          for (const e of hit) e.chargeStatus = "REVERSED";
          return { count: hit.length };
        },
      ),
    },
    payment: {
      findMany: jest.fn(
        async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in
            .map((id) => children.get(id)!)
            .filter((c) => c.billableToOrgInvoiceId !== null),
      ),
      updateMany: jest.fn(async ({ where }: { where: { id: string } }) => {
        const c = children.get(where.id);
        const ok =
          !!c &&
          c.paymentStatus === "SUCCEEDED" &&
          c.billableToOrgInvoiceId === null &&
          !hasReversal(c);
        return { count: ok ? 1 : 0 };
      }),
    },
    paymentLeg: {
      findUniqueOrThrow: jest.fn(
        async ({
          where,
        }: {
          where: { paymentId_source: { paymentId: string; source: string } };
        }) => {
          const { paymentId, source } = where.paymentId_source;
          const leg = children
            .get(paymentId)!
            .legs.find((l) => l.source === source)!;
          return leg;
        },
      ),
      create: jest.fn(async ({ data }: { data: Leg & { paymentId: string } }) =>
        children.get(data.paymentId)!.legs.push(data),
      ),
    },
    ledgerTransaction: {
      findUnique: jest.fn(
        async ({ where }: { where: { idempotencyKey: string } }) => {
          const entries = journals.get(where.idempotencyKey);
          return entries ? { id: where.idempotencyKey, entries } : null;
        },
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: {
            idempotencyKey: string;
            entries: {
              create: {
                accountId: string;
                direction: Entry["direction"];
                amountPaise: bigint;
              }[];
            };
          };
        }) => {
          journals.set(
            data.idempotencyKey,
            data.entries.create.map((e) => ({
              direction: e.direction,
              amountPaise: Number(e.amountPaise),
              account: accounts.get(e.accountId)!,
            })),
          );
          return { id: data.idempotencyKey };
        },
      ),
    },
    ledgerAccount: {
      createMany: jest.fn(
        async ({
          data,
        }: {
          data: { id: string; kind: string; organizationId: string | null }[];
        }) => {
          for (const row of data) {
            accounts.set(row.id, {
              kind: row.kind,
              organizationId: row.organizationId,
            });
          }
          return { count: data.length };
        },
      ),
    },
  });

  // The rollup's own read: unbilled, succeeded accrual payments and their legs.
  const invoiceCreate = jest.fn(async () => ({ id: "inv-new" }));
  Object.assign(mockRollupTx, {
    payment: {
      findMany: async () =>
        [...children.values()]
          .filter(
            (c) =>
              c.paymentStatus === "SUCCEEDED" &&
              c.billableToOrgInvoiceId === null,
          )
          .map((c) => ({ id: c.id, taxAmount: c.taxAmount, legs: c.legs })),
      updateMany: async () => ({ count: 1 }),
    },
    organizationInvoice: { create: invoiceCreate },
    invoiceLineItem: { findMany: async () => [] },
    overageEvent: { findMany: async () => [] },
  });

  return { tx, children, events, journals, invoiceCreate };
}

/** Σ debit − Σ credit per account kind across the journals named. */
function netByAccount(journals: Map<string, Entry[]>, keys: string[]) {
  const net: Record<string, number> = {};
  for (const key of keys)
    for (const e of journals.get(key) ?? [])
      net[e.account.kind] =
        (net[e.account.kind] ?? 0) +
        (e.direction === "DEBIT" ? e.amountPaise : -e.amountPaise);
  return net;
}

beforeEach(() => {
  mockRecordSystemEvent.mockClear();
});

describe("a cancelled LICENSE booking's CHARGE_ORG overage accruals", () => {
  it("voids each un-invoiced child so the ledger nets to zero and the rollup bills nothing", async () => {
    const w = world();

    await reverseBookingUtilization(w.tx, { paymentId: PARENT });

    for (const id of ["child-1", "child-2"]) {
      expect(w.children.get(id)!.legs).toContainEqual(
        expect.objectContaining({
          source: "OVERAGE_INVOICE_ACCRUAL_REVERSAL",
          amountPaise: -(SURCHARGE + GST),
        }),
      );
      const keys = [`overage-accrual:${id}`, `overage-accrual-voided:${id}`];
      expect(w.journals.has(keys[1])).toBe(true);
      expect(netByAccount(w.journals, keys)).toEqual({
        ORG_RECEIVABLE: 0,
        PLATFORM_FEE: 0,
        GST_PAYABLE: 0,
      });
    }
    expect(w.events.every((e) => e.chargeStatus === "REVERSED")).toBe(true);

    // A replayed reversal finds the sale spent and voids nothing twice.
    await reverseBookingUtilization(w.tx, { paymentId: PARENT });
    expect(w.children.get("child-1")!.legs).toHaveLength(2);
    expect(w.journals.size).toBe(4);
    expect(mockRecordSystemEvent).not.toHaveBeenCalled();

    const rollup = await rollupOrgInvoiceAccruals({
      organizationId: "org-1",
      issueImmediately: false,
    });
    expect(rollup.totalPaise).toBe(0);
    expect(w.invoiceCreate).not.toHaveBeenCalled();
  });

  it("leaves an invoiced child to the credit-note path and records one system event", async () => {
    const w = world(["child-2"]);

    await reverseBookingUtilization(w.tx, { paymentId: PARENT });

    expect(w.children.get("child-1")!.legs).toHaveLength(2);
    expect(w.children.get("child-2")!.legs).toHaveLength(1);
    expect(w.journals.has("overage-accrual-voided:child-2")).toBe(false);
    expect(mockRecordSystemEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          childPaymentIds: ["child-2"],
          invoiceIds: ["inv-1"],
        }),
      }),
    );
  });
});
