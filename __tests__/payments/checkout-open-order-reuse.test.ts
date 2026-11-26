/**
 * @jest-environment node
 */

/**
 * Rec C (bugs/finances/checkout-webhooks-idempotency.md Q2) — a checkout
 * remount or new tab mints a FRESH clientIdempotencyKey, which #828's
 * same-key replay cannot dedupe, so the old flow minted a parallel Razorpay
 * order for the same user+plan (parallel charges). handleCheckout must adopt
 * the open fresh PENDING payment instead of minting.
 *
 * State-based prisma mock (same idiom as cancel-pending-checkout.test.ts):
 * payment.findFirst evaluates the reuse WHERE faithfully against an
 * in-memory store so freshness/scoping actually decide, and the full
 * handleCheckout webinar flow runs under mocked locks/gateway so "no second
 * Razorpay order" is asserted on the real call graph.
 */

type MockDelegate = Record<string, jest.Mock>;
/** The buyer's own ConsultantProfile, when they are an expert too. */
const mockBuyer = { profile: null as { id: string } | null };
let txClient: Record<string, MockDelegate>;

/** The scalar slice of a Payment the reuse lookup filters on. */
type ReuseRow = {
  userId: string;
  paymentStatus: string;
  organizationId: string | null;
  paymentGateway: string;
  deletedAt: Date | null;
  expiresAt: Date | null;
  appointment?: Record<string, unknown> | null;
  [key: string]: unknown;
};
type ReuseWhere = {
  userId: string;
  paymentStatus: string;
  organizationId: string | null;
  paymentGateway: string;
  deletedAt: Date | null;
  expiresAt?: { gt: Date };
  appointment?: Record<string, unknown>;
};

// The notify-me hooks are pinned by their own suites; here they stage nothing.
jest.mock("@/lib/booking/event-waitlist", () => ({
  stageSeatOpenedNotices: jest.fn(async () => ({ pages: [], email: null })),
  finishSeatOpenedNotices: jest.fn(async () => undefined),
  markEventWaitlistBooked: jest.fn(async () => ({ count: 0 })),
  expireEventWaitlist: jest.fn(async () => ({ expired: 0, purged: 0 })),
  hasLapsedEventWaitlist: jest.fn(async () => false),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(
      // The expert-standing read under a share lock; no row reads as standing.
      // Non-enumerable, so assertions on the tx client itself are unchanged.
      async (fn: (tx: typeof txClient) => unknown, _opts?: unknown) =>
        fn(
          Object.defineProperty(txClient, "$queryRaw", {
            value: jest.fn(async () => []),
            configurable: true,
          }),
        ),
    ),
    payment: {
      // #1220-triage — the reuse lookup fetches the newest scope-matching
      // candidates; window/amount gates run in-code and rejects get
      // superseded via updateMany.
      findMany: jest.fn(async ({ where }: { where: ReuseWhere }) =>
        reuseState.rows.filter((row) => matchesReuseWhere(row, where)),
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
      // #1695 — the post-mint abort tombstone is written on the global client.
      create: jest.fn(async () => ({})),
      // A failed seat mint looks its pre-mint row up to release the seat.
      findUnique: jest.fn(async () => null),
    },
    // A dual-role buyer's own profile and the event's sessions (self atoms).
    consultantProfile: {
      findUnique: jest.fn(async () => mockBuyer.profile),
    },
    appointmentOccurrence: {
      findMany: jest.fn(async () => [
        {
          startsAt: new Date("2031-01-01T10:00:00.000Z"),
          endsAt: new Date("2031-01-01T11:00:00.000Z"),
        },
      ]),
    },
    webinar: {
      findUnique: jest.fn(async () => webinarRow()),
    },
  },
}));

jest.mock("../../utils/appointmentlock", () => ({
  requestLockBudget: () => ({}),
  renewConsulteeBooking: jest.fn(async () => undefined),
  __esModule: true,
  LockContentionError: class extends Error {},
  EventCheckoutLockUnavailableError: class extends Error {},
  BookingLockUnavailableError: class extends Error {},
  EventFullError: class extends Error {},
  EventCheckoutBusyError: class extends Error {},
  ConsulteeBookingBusyError: class extends Error {},
  SlotLockError: class extends Error {},
  CHECKOUT_LOCK_TTL_MS: {
    CONSULTATION: 60_000,
    SUBSCRIPTION: 120_000,
    WEBINAR: 120_000,
    CLASS: 600_000,
  },
  CHECKOUT_WAIT_RETRY_CONFIG: { retryCount: 5 },
  lockSlotBooking: jest.fn(async () => []),
  lockSlotBatch: jest.fn(async () => [{ key: "slot-booking:cp-buyer:x" }]),
  unlockSlotInterval: jest.fn(async () => undefined),
  unlockSlotBooking: jest.fn(async () => undefined),
  lockEventCheckout: jest.fn(async () => ({
    key: "event-checkout",
    value: "v",
    ttl: 120000,
    acquiredAt: Date.now(),
    client: {},
  })),
  unlockEventCheckout: jest.fn(async () => undefined),
  lockConsulteeBooking: jest.fn(async () => ({
    key: "consultee-booking",
    value: "v",
    ttl: 150000,
    acquiredAt: Date.now(),
    client: {},
  })),
  unlockConsulteeBooking: jest.fn(async () => undefined),
  extendLock: jest.fn(async () => true),
  extendSlotInterval: jest.fn(async () => true),
  slotGrantEntries: jest.fn(() => []),
}));

jest.mock("../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn(),
}));
jest.mock("../../lib/booking/pending-payment-expiry", () => ({
  __esModule: true,
  ...jest.requireActual("../../lib/booking/pending-payment-expiry"),
  cancelGatewayOrders: jest.fn(async () => undefined),
}));
jest.mock("../../lib/profiles/ensure-consultee-profile", () => ({
  __esModule: true,
  ensureConsulteeProfile: jest.fn(),
}));
jest.mock("../../lib/events/capacity", () => ({
  __esModule: true,
  getClassCapacity: jest.fn(() => ({ isFull: false })),
  getWebinarCapacity: jest.fn(() => ({ isFull: false })),
}));
jest.mock("../../lib/payments/tax/tax-engine", () => ({
  __esModule: true,
  determineTax: jest.fn(() => ({ taxAmount: 0 })),
  appointmentTypeToServiceType: jest.fn(() => "WEBINAR"),
}));
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/currency", () => ({
  __esModule: true,
  getExchangeRates: jest.fn(),
}));
jest.mock("../../lib/scheduling/schedulingTimezone", () => ({
  __esModule: true,
  resolveSchedulingTimezone: jest.fn(() => "Asia/Kolkata"),
}));
jest.mock("../../lib/referrals/service", () => ({
  __esModule: true,
  applyCreditsToPayment: jest.fn(),
  getUserCredits: jest.fn(async () => ({ totalAvailable: 0 })),
}));
jest.mock("../../lib/referrals/capture", () => ({
  __esModule: true,
  recordReferralCaptureInSavepoint: jest.fn(),
}));
jest.mock("../../lib/referrals/attribution", () => ({
  __esModule: true,
  asWelcomeDiscountConflict: (err: unknown) => err,
  resolveCheckoutAttribution: jest.fn(async () => ({
    source: "MARKETPLACE",
    referralId: null,
    platformFeeBps: 2000,
    welcomeDiscount: null,
    creditCapBps: 2000,
  })),
}));
jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
  resolvePaymentForEarnings: jest.fn(async () => null),
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  __esModule: true,
  walletDebit: jest.fn(),
}));
jest.mock("../../lib/payments/wallet-freeze", () => ({
  __esModule: true,
  isWalletFrozen: jest.fn(async () => false),
  WalletFrozenError: class extends Error {},
}));
jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn();
  return {
    __esModule: true,
    recordSystemError,
    recordSystemErrorSafe: recordSystemError,
  };
});
jest.mock("../../lib/api/organizations/program-helpers", () => ({
  __esModule: true,
  recordBookingUtilization: jest.fn(),
  ProgramAssignmentLimitError: class extends Error {},
}));
jest.mock("../../lib/payments/billing/overage-settlement", () => ({
  __esModule: true,
  recordOverageAtCheckout: jest.fn(),
}));
jest.mock("../../lib/enterprise/governance", () => ({
  __esModule: true,
  getInvoiceCreditLimitPaise: jest.fn(() => null),
  assertVerifiedDomainOrThrow: jest.fn(),
}));
jest.mock("../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));
jest.mock("../../lib/feature-flags", () => ({
  __esModule: true,
  ENABLE_DUNNING_SUSPEND: false,
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  __esModule: true,
  notifyOrgProgramExhausted: jest.fn(),
  notifyOrgProgramCapNear: jest.fn(),
}));
// #1499 — checkout now resolves a policy VERSION id rather than freezing Json.
jest.mock("../../lib/payments/operations/cancellation-policy-store", () => ({
  __esModule: true,
  // #1513 review — the platform row is provisioned on the global client just
  // before the booking transaction opens, so the mock has to answer that too.
  ensurePlatformCancellationPolicy: jest.fn(async () => "policy-platform"),
  resolveCheckoutCancellationPolicyId: jest.fn(async () => "policy-1"),
}));

import prisma from "../../lib/prisma";
import {
  cancelPaymentIntent,
  createPaymentIntent,
} from "../../lib/payments/index";
import { cancelGatewayOrders } from "../../lib/booking/pending-payment-expiry";
import { PaymentError } from "../../lib/payments/core/types";
import {
  createEarningsFromPayment,
  resolvePaymentForEarnings,
} from "../../lib/payments/payouts";
import {
  unlockConsulteeBooking,
  unlockEventCheckout,
} from "../../utils/appointmentlock";
import { handleCheckout } from "../../lib/payments/checkout";
import {
  readInvoiceExposurePaise,
  assertWithinInvoiceCreditLimit,
} from "../../lib/payments/checkout/org-funding";

// ---------------------------------------------------------------------------
// In-memory store + faithful evaluation of the reuse lookup's WHERE clause.
// ---------------------------------------------------------------------------

const reuseState: { rows: ReuseRow[] } = { rows: [] };

function matchesReuseWhere(row: ReuseRow, where: ReuseWhere): boolean {
  if (row.userId !== where.userId) return false;
  if (row.paymentStatus !== where.paymentStatus) return false;
  // Null-safe org equality — mirrors Prisma's behavior for `organizationId`.
  if (row.organizationId !== where.organizationId) return false;
  if (row.paymentGateway !== where.paymentGateway) return false;
  if (row.deletedAt !== where.deletedAt) return false;
  if (where.expiresAt?.gt) {
    if (!row.expiresAt || !(row.expiresAt > where.expiresAt.gt)) return false;
  }
  const filter = where.appointment ?? {};
  const target = row.appointment ?? {};
  for (const [key, cond] of Object.entries(filter)) {
    // Prisma semantics: an undefined relation condition filters nothing —
    // which is exactly what the helper must never allow for events.
    if (cond === undefined) continue;
    const got = target[key];
    if (cond !== null && typeof cond === "object") {
      for (const [k2, v2] of Object.entries(cond as Record<string, unknown>)) {
        if ((got as Record<string, unknown>)?.[k2] !== v2) return false;
      }
    } else if (got !== cond) return false;
  }
  return true;
}

/** The webinar the checkout flow reads (capacity pre-check + handler). */
function webinarRow() {
  return {
    id: "evt-1",
    status: "SCHEDULED",
    webinarPlan: {
      id: "wplan-1",
      price: 100000,
      priceCurrency: "INR",
      organizationId: null,
      // Storefront gates (E2E audit): the checkout transaction re-checks
      // seller verification, archival and marketplace visibility that the
      // browse surfaces already enforce. `include:` returns every scalar in
      // production, so the fixture carries them too.
      archivedAt: null,
      visibility: "PUBLIC",
      consultantProfile: {
        id: "cp-1",
        userId: "consultant-u1",
        verificationStatus: "VERIFIED",
      },
    },
    appointment: {
      id: "appt-w",
      // The include always returns the live-seat array; nobody holds a seat here.
      participants: [],
      occurrences: [
        {
          id: "slot-1",
          endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          user: [],
        },
      ],
    },
  };
}

/** An open fresh PENDING sibling for user-1 on evt-1 (the first attempt). */
function openSibling(overrides: Partial<ReuseRow> = {}): ReuseRow {
  return {
    id: "pay-open",
    userId: "user-1",
    paymentIntent: "order_OPEN",
    paymentStatus: "PENDING",
    expiresAt: new Date(Date.now() + 20 * 60 * 1000),
    organizationId: null,
    paymentGateway: "RAZORPAY",
    deletedAt: null,
    isMockPayment: false,
    // #780 — extended-client reads surface bigint money as Number.
    amount: 100000,
    currency: "INR",
    appointmentId: "appt-w",
    appointment: {
      webinarId: "evt-1",
      // The buyer's own seat, held by this open order.
      participants: [{ status: "HELD" }],
      // Window gate reads the first slot (WEBINAR flow skips it, but keep the
      // shape faithful for the direct unit cases below).
      occurrences: [
        {
          startsAt: new Date("2026-09-01T10:00:00Z"),
          endsAt: new Date("2026-09-01T11:00:00Z"),
        },
      ],
    },
    ...overrides,
  };
}

function checkoutInput(overrides: Record<string, unknown> = {}) {
  return {
    appointmentType: "WEBINAR",
    planId: "wplan-1",
    eventId: "evt-1",
    paymentGateway: "RAZORPAY",
    clientIdempotencyKey: "remount-tab-key-0002",
    consumerStateCode: "29",
    ...overrides,
  } as unknown as Parameters<typeof handleCheckout>[0];
}

beforeEach(() => {
  reuseState.rows = [];
  mockBuyer.profile = null;
  txClient = {
    user: { findUnique: jest.fn(async () => userRow()) },
    membership: { findFirst: jest.fn(async () => null) },
    webinarPlan: {
      findUnique: jest.fn(async () => ({
        consultantProfileId: "cp-1",
        organizationId: null,
      })),
    },
    webinar: {
      findUnique: jest.fn(async () => webinarRow()),
      count: jest.fn(async () => 1),
    },
    appointmentOccurrence: {
      update: jest.fn(async ({ where }: { where: unknown }) => where),
    },
    appointmentParticipant: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      // A seat confirmed at birth returns its row, for its SEAT history row.
      createManyAndReturn: jest.fn(async ({ data }: { data: object[] }) =>
        data.map((row, i) => ({ id: `seat-${i}`, ...row })),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingStatusHistory: { createMany: jest.fn(async () => ({ count: 1 })) },
    consulteeProfile: {
      findUnique: jest.fn(async () => ({ userId: "user_1" })),
    },
    payment: {
      create: jest.fn(async ({ data }: { data: { amount: number } }) => ({
        id: "pay-new",
        // #780 — the extended client reads bigint money back as Number.
        amount: data.amount,
      })),
      updateManyAndReturn: jest.fn(async () => []),
      // The buyer's prior seat payment on this event; none here.
      findFirst: jest.fn(async () => null),
      // The seat's order is filled into its pre-mint row after the commit.
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    paymentLeg: {
      create: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async () => [{ source: "CARD", amountPaise: 100000 }]),
    },
  };
  (createPaymentIntent as jest.Mock).mockResolvedValue({
    id: "order_NEW",
    client_secret: null,
  });
});

/** The buyer. No consultant profile — nobody buys their own plan here. */
function userRow() {
  return {
    id: "user-1",
    consulteeProfile: { id: "cprof-1", billingStateCode: "29" },
    consultantProfile: null,
  };
}

describe("rec C — checkout adopts an open PENDING order across remounts", () => {
  it("a second request with a DIFFERENT client key resumes the same order and mints no second gateway order", async () => {
    reuseState.rows.push(openSibling());

    const res = await handleCheckout(
      checkoutInput({ clientIdempotencyKey: "brand-new-tab-key-9" }),
      "user-1",
    );

    expect(res.success).toBe(true);
    expect(res).toMatchObject({
      reused: true,
      orderId: "order_OPEN",
      currency: "INR",
      isMockPayment: false,
      message: "Resuming your in-progress checkout.",
    });
    // BigInt paise cross the boundary as Number (same as the #828 replay).
    expect(res.amount).toBe(100000);
    expect(res.paymentIntent).toEqual({
      id: "order_OPEN",
      client_secret: null,
    });

    // THE point of rec C: no parallel Razorpay order exists to pay.
    expect(createPaymentIntent).not.toHaveBeenCalled();

    // The lookup must be scoped tightly — user + PENDING +
    // org equality + gateway + this event's appointment join.
    // #1478 — expiresAt is evaluated in-code so expired PENDING rows are
    // superseded and released rather than silently left occupying the calendar.
    const where = (prisma.payment.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({
      userId: "user-1",
      paymentStatus: "PENDING",
      organizationId: null,
      paymentGateway: "RAZORPAY",
      deletedAt: null,
      appointment: { webinarId: "evt-1" },
    });
    expect(where.expiresAt).toBeUndefined();

    // Early return still releases both locks via the finally block.
    expect(unlockEventCheckout).toHaveBeenCalled();
    expect(unlockConsulteeBooking).toHaveBeenCalled();
  });

  it.each([
    [
      "the hold has expired",
      openSibling({ expiresAt: new Date(Date.now() - 60 * 1000) }),
    ],
    [
      "the sibling already SUCCEEDED",
      openSibling({ paymentStatus: "SUCCEEDED" }),
    ],
    ["the sibling belongs to another user", openSibling({ userId: "user-2" })],
    [
      "the sibling is for a different event's appointment",
      openSibling({ appointment: { webinarId: "evt-other" } }),
    ],
    [
      "the sibling was minted under another org",
      openSibling({ organizationId: "org-other" }),
    ],
  ])("mints fresh when %s", async (_label, sibling) => {
    reuseState.rows.push(sibling);

    const res = await handleCheckout(checkoutInput(), "user-1");

    expect(res.success).toBe(true);
    expect((res as Record<string, unknown>).reused).toBeUndefined();
    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 100000,
        currency: "INR",
        paymentGateway: "RAZORPAY",
      }),
    );
    expect(res.paymentIntent?.id).toBe("order_NEW");
  });
});

// #1592 A-P1-05 — an unknown discount code used to be ignored: the buyer was
// charged full price with no word about the code they typed. It is now a
// coded 400 refusal raised before any Payment row or gateway order exists.
describe("an unknown discount code is refused, not silently ignored", () => {
  it("throws DISCOUNT_CODE_INVALID and mints nothing", async () => {
    txClient.discountCode = { findUnique: jest.fn(async () => null) };

    await expect(
      handleCheckout(checkoutInput({ discountCode: "NOPE10" }), "user-1"),
    ).rejects.toMatchObject({
      code: "DISCOUNT_CODE_INVALID",
      httpStatus: 400,
      message: "That discount code is not valid for this purchase",
    });

    expect(txClient.discountCode.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: "NOPE10" } }),
    );
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(txClient.payment.create).not.toHaveBeenCalled();
  });
});

// #1591 J3-P1-01 — both credit-limit gates summed INVOICE_ACCRUAL legs without
// their negative *_REVERSAL siblings, so a refunded seat kept counting against
// the org's limit. The one helper nets them the way the monthly rollup does.
describe("readInvoiceExposurePaise nets accrual reversals", () => {
  it("an accrual with a matching reversal contributes 0", async () => {
    const legs = [
      { source: "INVOICE_ACCRUAL", amountPaise: 100_000 },
      { source: "INVOICE_ACCRUAL_REVERSAL", amountPaise: -100_000 },
      { source: "OVERAGE_INVOICE_ACCRUAL", amountPaise: 25_000 },
    ];
    const db = {
      paymentLeg: {
        aggregate: jest.fn(
          async ({ where }: { where: { source: { in: string[] } } }) => ({
            _sum: {
              amountPaise: legs
                .filter((l) => where.source.in.includes(l.source))
                .reduce((s, l) => s + l.amountPaise, 0),
            },
          }),
        ),
      },
      organizationInvoice: {
        aggregate: jest.fn(async () => ({ _sum: { totalPaise: 10_000 } })),
      },
    };

    const exposure = await readInvoiceExposurePaise(
      db as unknown as Parameters<typeof readInvoiceExposurePaise>[0],
      "org-1",
    );

    // Only the un-reversed overage accrual and the unpaid invoice remain.
    expect(exposure).toBe(35_000);
  });

  it("a partial reversal leaves the rest of the accrual counting", async () => {
    const legs = [
      { source: "INVOICE_ACCRUAL", amountPaise: 100_000 },
      { source: "INVOICE_ACCRUAL_REVERSAL", amountPaise: -30_000 },
    ];
    const db = {
      paymentLeg: {
        aggregate: jest.fn(
          async ({ where }: { where: { source: { in: string[] } } }) => ({
            _sum: {
              amountPaise: legs
                .filter((l) => where.source.in.includes(l.source))
                .reduce((s, l) => s + l.amountPaise, 0),
            },
          }),
        ),
      },
      organizationInvoice: {
        aggregate: jest.fn(async () => ({ _sum: { totalPaise: 0 } })),
      },
    };

    const exposure = await readInvoiceExposurePaise(
      db as unknown as Parameters<typeof readInvoiceExposurePaise>[0],
      "org-1",
    );

    expect(exposure).toBe(70_000);
  });

  // #1744 row 4 — the booking itself counts, and the copy is in rupees.
  it("₹49,999 outstanding + a ₹10 booking is refused against a ₹50,000 limit", () => {
    expect(() =>
      assertWithinInvoiceCreditLimit(49_999_00, 10_00, 50_000_00),
    ).toThrow(
      expect.objectContaining({
        code: "ORG_CREDIT_LIMIT_REACHED",
        httpStatus: 402,
        message: expect.stringContaining("₹50,000"),
      }),
    );
    expect(() =>
      assertWithinInvoiceCreditLimit(49_999_00, 10_00, 50_000_00),
    ).toThrow(
      expect.not.objectContaining({ message: expect.stringMatching(/paise/i) }),
    );
    expect(() =>
      assertWithinInvoiceCreditLimit(49_990_00, 10_00, 50_000_00),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// #1220-triage — the gates themselves, exercised directly (the webinar flow
// above cannot discriminate them: eventId already pins scope and its fixtures
// share one price).
// ---------------------------------------------------------------------------
import { findReusablePendingOrderPayment } from "../../lib/payments/checkout/order-reuse";

const SLOT = {
  startsAt: new Date("2026-09-01T10:00:00Z"),
  endsAt: new Date("2026-09-01T11:00:00Z"),
};
const OTHER_SLOT = {
  startsAt: new Date("2026-09-02T10:00:00Z"),
  endsAt: new Date("2026-09-02T11:00:00Z"),
};

function gateDb(rows: Array<Record<string, unknown>>) {
  return { payment: { findMany: async () => rows } };
}

describe("#1220-triage — reuse gates", () => {
  test("CONSULTATION: a live order for a different slot time is neither resumed nor superseded", async () => {
    const row = openSibling({
      appointment: {
        consultationId: "cons_1",
        occurrences: [OTHER_SLOT],
      },
    });
    const { reusable, supersede } = await findReusablePendingOrderPayment(
      gateDb([row]) as never,
      {
        userId: "user-1",
        appointmentType: "CONSULTATION",
        planId: "plan-1",
        organizationId: null,
        paymentGateway: "RAZORPAY" as never,
        expectedAmountPaise: 100_000,
        expectedDiscountCodeId: null,
        slotWindow: SLOT,
      },
    );
    // Two tabs, one plan, two windows: both checkouts stay live.
    expect(reusable).toBeNull();
    expect(supersede).toEqual([]);
  });

  test("CONSULTATION: identical slot window resumes", async () => {
    const row = openSibling({
      appointment: { consultationId: "cons_1", occurrences: [SLOT] },
    });
    const { reusable, supersede } = await findReusablePendingOrderPayment(
      gateDb([row]) as never,
      {
        userId: "user-1",
        appointmentType: "CONSULTATION",
        planId: "plan-1",
        organizationId: null,
        paymentGateway: "RAZORPAY" as never,
        expectedAmountPaise: 100_000,
        expectedDiscountCodeId: null,
        slotWindow: SLOT,
      },
    );
    expect(reusable?.id).toBe("pay-open");
    expect(supersede).toEqual([]);

    // The same amount under another code is superseded, so the old code's use is given back.
    const recoded = await findReusablePendingOrderPayment(
      gateDb([{ ...row, discountCodeId: "dc-a" }]) as never,
      {
        userId: "user-1",
        appointmentType: "CONSULTATION",
        planId: "plan-1",
        organizationId: null,
        paymentGateway: "RAZORPAY" as never,
        expectedAmountPaise: 100_000,
        expectedDiscountCodeId: "dc-b",
        slotWindow: SLOT,
      },
    );
    expect(recoded.reusable).toBeNull();
    expect(recoded.supersede).toEqual([
      { id: "pay-open", reason: "discount-mismatch" },
    ]);
  });

  test("a group order whose seat was released is superseded, not resumed", async () => {
    const row = openSibling();
    row.appointment = {
      ...row.appointment,
      participants: [{ status: "CANCELLED" }],
    };
    const { reusable, supersede } = await findReusablePendingOrderPayment(
      gateDb([row]) as never,
      {
        userId: "user-1",
        appointmentType: "WEBINAR",
        planId: "plan-1",
        eventId: "evt-1",
        organizationId: null,
        paymentGateway: "RAZORPAY" as never,
        expectedAmountPaise: 100_000,
        expectedDiscountCodeId: null,
      },
    );
    expect(reusable).toBeNull();
    expect(supersede).toEqual([{ id: "pay-open", reason: "seat-released" }]);
  });

  test("amount parity gate: a stale frozen total is superseded, not resumed", async () => {
    const row = openSibling({ amount: 80_000 }); // coupon changed since mint
    const { reusable, supersede } = await findReusablePendingOrderPayment(
      gateDb([row]) as never,
      {
        userId: "user-1",
        appointmentType: "WEBINAR",
        planId: "plan-1",
        eventId: "evt-1",
        organizationId: null,
        paymentGateway: "RAZORPAY" as never,
        expectedAmountPaise: 100_000,
        expectedDiscountCodeId: null,
      },
    );
    expect(reusable).toBeNull();
    expect(supersede).toEqual([{ id: "pay-open", reason: "amount-mismatch" }]);
  });

  test("SUBSCRIPTION: a live order for another period is left alone; both-null matches both-null only", async () => {
    const withPeriod = openSibling({
      id: "pay-period",
      appointment: {
        subscriptionId: "sub_1",
        occurrences: [SLOT],
      },
    });
    const withoutPeriod = openSibling({
      id: "pay-noperiod",
      appointment: { subscriptionId: "sub_2", occurrences: [] },
    });

    // Request WITH a period must not resume a period-less hold.
    const gated = await findReusablePendingOrderPayment(
      gateDb([withoutPeriod, withPeriod]) as never,
      {
        userId: "user-1",
        appointmentType: "SUBSCRIPTION",
        planId: "plan-1",
        organizationId: null,
        paymentGateway: "RAZORPAY" as never,
        expectedAmountPaise: 100_000,
        expectedDiscountCodeId: null,
        schedulingPeriod: SLOT,
      },
    );
    expect(gated.reusable?.id).toBe("pay-period");
    expect(gated.supersede).toEqual([]);

    // Keyless request must not resume a hold that carries a period.
    const keyless = await findReusablePendingOrderPayment(
      gateDb([withPeriod]) as never,
      {
        userId: "user-1",
        appointmentType: "SUBSCRIPTION",
        planId: "plan-1",
        organizationId: null,
        paymentGateway: "RAZORPAY" as never,
        expectedAmountPaise: 100_000,
        expectedDiscountCodeId: null,
        schedulingPeriod: null,
      },
    );
    expect(keyless.reusable).toBeNull();
    expect(keyless.supersede).toEqual([]);
  });
});

describe("a dual-role seat buyer's own calendar", () => {
  it("takes the buyer's own atoms for the event's sessions and frees them before the mint", async () => {
    const locks = jest.requireMock("../../utils/appointmentlock") as {
      lockSlotBatch: jest.Mock;
      unlockSlotInterval: jest.Mock;
    };
    mockBuyer.profile = { id: "cp-buyer" };

    await handleCheckout(checkoutInput(), "user-1");

    expect(locks.lockSlotBatch).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          consultantProfileId: "cp-buyer",
          startsAt: new Date("2031-01-01T10:00:00.000Z"),
        }),
      ],
      expect.any(Number),
      expect.anything(),
    );
    const released = locks.unlockSlotInterval.mock.invocationCallOrder[0];
    const minted = (createPaymentIntent as jest.Mock).mock
      .invocationCallOrder[0];
    expect(released).toBeLessThan(minted);
  });

  it("takes no self atoms for a buyer who hosts nothing", async () => {
    const locks = jest.requireMock("../../utils/appointmentlock") as {
      lockSlotBatch: jest.Mock;
    };
    locks.lockSlotBatch.mockClear();

    await handleCheckout(checkoutInput(), "user-1");

    expect(locks.lockSlotBatch).not.toHaveBeenCalled();
  });
});

describe("seat checkout mints its order after the commit", () => {
  it("an aborted seat commit mints no gateway order, so nothing is orphaned", async () => {
    txClient.payment.create = jest.fn(async () => {
      throw new Error(
        "CREDIT_SHORTFALL: expected 500 paise credits but only 0 available. Aborting for retry.",
      );
    });

    await expect(handleCheckout(checkoutInput(), "user-1")).rejects.toThrow();

    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("commits the seat under a pre-mint intent, then fills in the minted order", async () => {
    const res = await handleCheckout(checkoutInput(), "user-1");

    const written = (txClient.payment.create as jest.Mock).mock.calls[0][0]
      .data as { paymentIntent: string };
    expect(written.paymentIntent).toMatch(/^premint_/);
    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(txClient.payment.updateMany).toHaveBeenCalledWith({
      where: { paymentIntent: written.paymentIntent, paymentStatus: "PENDING" },
      data: { paymentIntent: "order_NEW" },
    });
    expect(res).toMatchObject({ paymentIntent: { id: "order_NEW" } });
  });

  it("a gateway failure after the seat commit answers the gateway's own error", async () => {
    (createPaymentIntent as jest.Mock).mockRejectedValueOnce(
      new PaymentError("The gateway is unavailable", "GATEWAY_UNAVAILABLE"),
    );

    await expect(
      handleCheckout(checkoutInput(), "user-1"),
    ).rejects.toMatchObject({
      name: "PaymentError",
      code: "GATEWAY_UNAVAILABLE",
    });
    // The pre-mint id names no gateway order: nothing to cancel or tombstone.
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("a seat hold that lapsed before its order was filled answers SEAT_HOLD_LAPSED and voids the fresh order", async () => {
    txClient.payment.updateMany = jest.fn(async () => ({ count: 0 }));

    await expect(
      handleCheckout(checkoutInput(), "user-1"),
    ).rejects.toMatchObject({ code: "SEAT_HOLD_LAPSED", httpStatus: 409 });
    expect(cancelGatewayOrders).toHaveBeenCalledWith(
      [{ paymentIntent: "order_NEW", gateway: "RAZORPAY" }],
      expect.anything(),
    );
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });
});

describe("synchronous rails settle earnings in Phase 1", () => {
  it("writes earnings and the booking journal through the checkout tx, not after commit", async () => {
    const resolved = {
      paymentForEarnings: { id: "pay-new" },
      earningsAppointmentType: "WEBINAR",
      consultantProfileId: "cp-1",
    };
    (resolvePaymentForEarnings as jest.Mock).mockResolvedValueOnce(resolved);

    const res = await handleCheckout(checkoutInput(), "user-1", true);

    expect(res.success).toBe(true);
    expect(resolvePaymentForEarnings).toHaveBeenCalledTimes(1);
    expect(resolvePaymentForEarnings).toHaveBeenCalledWith(
      { id: "pay-new" },
      "WEBINAR",
      txClient,
    );
    expect(createEarningsFromPayment).toHaveBeenCalledTimes(1);
    expect(createEarningsFromPayment).toHaveBeenCalledWith({
      payment: resolved.paymentForEarnings,
      appointmentType: "WEBINAR",
      tx: txClient,
    });
  });
});
