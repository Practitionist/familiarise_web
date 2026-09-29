/**
 * @jest-environment node
 */

/**
 * #1181 — approval payments carry their appointment.
 *
 * Approval-flow mints used to leave appointmentId null, which made three
 * guards inert (the duplicate-payment walk over appointment.payment, the
 * approval route's own hasPayment check and its PaidWithoutAppointmentError)
 * and sent the capture webhook down the legacy-create path — building a twin
 * Appointment for a one-to-one Consultation. State-based prisma mock (same
 * idiom as cancel-pending-checkout.test.ts): here we pin that
 *
 *  1. the mint threads appointmentId into both the gateway metadata and the
 *     Payment row, exactly like direct checkout;
 *  2. the duplicate-payment guard now MATCHES a PENDING payment already
 *     hanging off the same appointment and REUSES it (same intent, no second
 *     gateway order) instead of minting a parallel one;
 *  3. a SUCCEEDED payment still refuses; an EXPIRED one falls through to a
 *     fresh mint;
 *  4. both approval routes actually pass the appointment through (source
 *     contract, so a revert fails loudly).
 */

import fs from "fs";
import path from "path";
import {
  AppointmentStatus,
  Currency,
  PaymentStatus,
  TrialStatus,
} from "@prisma/client";

const CUID = "clw0000000000000000000000";
const PLAN_CUID = "clw1111111111111111111111";
const APPT_CUID = "clw2222222222222222222222";
const CONS_CUID = "clw3333333333333333333333";

interface State {
  user: Record<string, unknown> | null;
  consultationPlan: Record<string, unknown> | null;
  /** What the duplicate guard's walk over consultation.appointment.payment finds. */
  appointmentPayments: Array<Record<string, unknown>>;
  /** Whether the consultation is still payable, which gates the re-mint. */
  consultationStatus: string;
  /** What findExistingLivePayment's trial arm reads off Trial.payment. */
  trialPayment?: Record<string, unknown> | null;
  trialStatus?: string;
  /** What the re-mint CAS matches (1 = the row was still ours). */
  remintCasCount: number;
  /** What the lost-CAS re-read returns. */
  remintFreshRow: Record<string, unknown> | null;
}

let state: State;
// The tx client forwards to the same mocks so assertions read one place.
const prismaMockRef: {
  payment: { updateMany: unknown };
  paymentLeg: { updateMany: unknown };
} = { payment: { updateMany: null }, paymentLeg: { updateMany: null } };

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(async () => state.user),
    },
    consultationPlan: {
      findUnique: jest.fn(async () => state.consultationPlan),
    },
    consultation: {
      // Hydrates the include shape findExistingLivePayment walks.
      findUnique: jest.fn(async () => ({
        id: CONS_CUID,
        status: state.consultationStatus,
        appointment: { id: APPT_CUID, payment: state.appointmentPayments },
      })),
    },
    payment: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "pay-new",
        ...data,
      })),
      // CodeRabbit r2 — the re-mint is a CAS updateMany inside a tx; the
      // count is what the test steers to model a capture landing first.
      updateMany: jest.fn(async () => ({ count: state.remintCasCount })),
      findUnique: jest.fn(async () => state.remintFreshRow),
      // #1775 P-1 — the trial arm reads through the appointment first; none here.
      findFirst: jest.fn(async () => null),
    },
    paymentLeg: { updateMany: jest.fn(async () => ({ count: 1 })) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        payment: {
          updateMany: (...a: unknown[]) =>
            (prismaMockRef.payment.updateMany as jest.Mock)(...a),
        },
        paymentLeg: {
          updateMany: (...a: unknown[]) =>
            (prismaMockRef.paymentLeg.updateMany as jest.Mock)(...a),
        },
      }),
    ),
    trial: {
      // Hydrates the include shape findExistingLivePayment's trial arm walks.
      findUnique: jest.fn(async () => ({
        id: "trial-1",
        status: state.trialStatus,
        payment: state.trialPayment,
      })),
    },
    subscriptionPlan: {
      // Trial pricing reads the parent subscription plan (trialPriceInPaise
      // fallback path in calculateAmount).
      findUnique: jest.fn(async () => ({
        title: "Trial Plan",
        price: 500_000,
        priceCurrency: Currency.INR,
        trialEnabled: true,
        trialPriceInPaise: 250_000,
      })),
    },
  },
}));

const mockCreatePaymentIntent = jest.fn();

jest.mock("../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: (...a: unknown[]) =>
    mockCreatePaymentIntent(...(a as [])),
}));

jest.mock("../../utils/appointmentlock", () => ({
  __esModule: true,
  APPROVAL_LOCK_TTL_MS: 45_000,
  lockApprovalPaymentMint: jest.fn(async () => ({ key: "k", token: "t" })),
  unlockApproval: jest.fn(async () => undefined),
}));
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  acquireLock: jest.fn(async () => "lock-token"),
  releaseLock: jest.fn(async () => undefined),
}));

// #1583 C-P0-01 — an export is zero-rated only under a valid platform LUT;
// toggled per test so the non-IN pin is about the country, not the env.
let lutValid = false;
jest.mock("../../lib/compliance/lut", () => ({
  __esModule: true,
  hasValidPlatformLut: () => lutValid,
}));

// CodeRabbit r1 — the loser of a double-accept tombstones its minted order
// (#1695). Boundary-mocked: checkout.ts's import graph is not under test.
const mockTombstone = jest.fn<Promise<boolean>, [Record<string, unknown>]>(
  async () => true,
);
jest.mock("../../lib/payments/operations/checkout", () => ({
  __esModule: true,
  tombstoneAbortedGatewayOrder: (input: Record<string, unknown>) =>
    mockTombstone(input),
}));

import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  ApprovalAlreadyPaidError,
  ApprovalPaymentExistsError,
  ApprovalWindowLapsedError,
  createApprovalPaymentIntent,
} from "../../lib/payments/operations/approval-payment";
import { deriveCheckoutAmount } from "../../lib/payments/pricing/derive-checkout-amount";

const mockedPaymentCreate = prisma.payment.create as jest.Mock;
const mockedPaymentUpdate = prisma.payment.updateMany as jest.Mock;
const mockedLegUpdate = prisma.paymentLeg.updateMany as jest.Mock;
prismaMockRef.payment.updateMany = mockedPaymentUpdate;
prismaMockRef.paymentLeg.updateMany = mockedLegUpdate;

function freshState(): State {
  return {
    user: { id: CUID, consulteeProfile: { id: "consultee-1" } },
    consultationPlan: {
      title: "Career Clarity",
      price: 500_000,
      priceCurrency: Currency.INR,
    },
    appointmentPayments: [],
    consultationStatus: AppointmentStatus.APPROVED_PENDING_PAYMENT,
    trialStatus: TrialStatus.AWAITING_PAYMENT,
    remintCasCount: 1,
    remintFreshRow: null,
  };
}

/** A live row frozen at the taxed figure — the shape the reuse branch accepts. */
function taxedRow(extra: Record<string, unknown> = {}) {
  return {
    paymentStatus: PaymentStatus.PENDING,
    paymentIntent: "order_existing",
    amount: TAXED_PLAN_PAISE,
    originalAmount: 500_000,
    taxAmount: 90_000,
    isInternational: false,
    buyerCountry: "IN",
    currency: Currency.INR,
    ...extra,
  };
}

/** ₹5,000 list price plus 18% GST for an IN buyer (#1583 C-P0-01). */
const TAXED_PLAN_PAISE = 590_000;

beforeEach(() => {
  state = freshState();
  lutValid = false;
  jest.clearAllMocks();
  mockCreatePaymentIntent.mockResolvedValue({
    id: "order_new",
    client_secret: "order_new",
    amount: TAXED_PLAN_PAISE,
    currency: "INR",
    status: "created",
  });
});

function mintParams() {
  return {
    userId: CUID,
    appointmentType: "CONSULTATION" as const,
    consultationId: CONS_CUID,
    planId: PLAN_CUID,
    appointmentId: APPT_CUID,
    paymentGateway: "RAZORPAY" as const,
    startsAt: "2026-09-01T10:00:00.000Z",
    endsAt: "2026-09-01T10:30:00.000Z",
  };
}

describe("approval mint threads appointmentId (#1181)", () => {
  it("sends the real appointment id in the gateway metadata, not the pending sentinel", async () => {
    await createApprovalPaymentIntent(mintParams());

    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    const intentArg = mockCreatePaymentIntent.mock.calls[0][0];
    expect(intentArg.metadata.appointmentId).toBe(APPT_CUID);
    expect(intentArg.metadata.isApprovalFlow).toBe("true");
  });

  it("stamps appointmentId onto the Payment row", async () => {
    const result = await createApprovalPaymentIntent(mintParams());

    expect(result.paymentIntentId).toBe("order_new");
    const created = mockedPaymentCreate.mock.calls[0][0].data;
    expect(created.appointmentId).toBe(APPT_CUID);
    expect(created.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(created.amount).toBe(TAXED_PLAN_PAISE);
  });

  it("omits the metadata key entirely when there is no appointment yet", async () => {
    // Defect 17 — the second path still wrote the literal "pending", which the
    // Payment column stopped doing. Gateway notes are string-valued, so an
    // absent key IS that null: a reader can now tell "no appointment yet" from
    // an appointment whose id happens to read like a sentinel.
    const { appointmentId: _dropped, ...withoutAppointment } = mintParams();
    await createApprovalPaymentIntent(withoutAppointment);

    const intentArg = mockCreatePaymentIntent.mock.calls[0][0];
    expect(intentArg.metadata).not.toHaveProperty("appointmentId");
    expect(mockedPaymentCreate.mock.calls[0][0].data.appointmentId).toBeNull();
  });
});

describe("duplicate-payment guard sees approval payments (#1181)", () => {
  it("REUSES a PENDING payment hanging off the same appointment instead of minting a parallel order", async () => {
    state.appointmentPayments = [taxedRow()];

    const result = await createApprovalPaymentIntent(mintParams());

    // Same intent handed back — Razorpay's checkout url IS the order id, so
    // this reconstructs the original pay-link without a gateway round-trip.
    expect(result).toEqual({
      paymentIntentId: "order_existing",
      checkoutUrl: "order_existing",
      amount: TAXED_PLAN_PAISE,
      currency: Currency.INR,
    });
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
  });

  // #1583 C-P0-01 — a live row minted before tax parity carries the pre-tax
  // figure; handing it back would charge the stale number.
  it("re-mints into a live PENDING row whose frozen amount differs from the taxed figure", async () => {
    state.appointmentPayments = [
      {
        id: "pay-pretax",
        paymentStatus: PaymentStatus.PENDING,
        paymentIntent: "order_pretax",
        amount: 500_000,
        currency: Currency.INR,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];

    const result = await createApprovalPaymentIntent(mintParams());

    expect(result.paymentIntentId).toBe("order_new");
    expect(result.amount).toBe(TAXED_PLAN_PAISE);
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
    const [{ where, data }] = mockedPaymentUpdate.mock.calls[0];
    // CodeRabbit r2 — the pre-read's status and intent ride the WHERE.
    expect(where).toEqual({
      id: "pay-pretax",
      paymentStatus: PaymentStatus.PENDING,
      paymentIntent: "order_pretax",
    });
    expect(data).toMatchObject({
      amount: TAXED_PLAN_PAISE,
      originalAmount: 500_000,
      taxAmount: 90_000,
    });
    expect(mockedLegUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paymentId: "pay-pretax", source: "CARD" },
        data: { amountPaise: TAXED_PLAN_PAISE, sourceRef: "order_new" },
      }),
    );
  });

  // CodeRabbit r2 follow-up — two countries can carry one tax figure (both
  // fail-closed exports), and the invoice's place of supply reads the country.
  it("re-mints when only the frozen buyer country differs", async () => {
    state.appointmentPayments = [
      taxedRow({
        id: "pay-gb",
        buyerCountry: "GB",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ];
    const result = await createApprovalPaymentIntent(mintParams());

    expect(result.paymentIntentId).toBe("order_new");
    expect(mockedPaymentUpdate).toHaveBeenCalledTimes(1);
    expect(mockedPaymentUpdate.mock.calls[0][0].data.buyerCountry).toBe("IN");
  });

  // CodeRabbit r2 — the same total under a different tax classification is a
  // different sale; the reuse gate compares the whole frozen pricing state.
  it("re-mints when the total matches but the tax classification differs", async () => {
    state.appointmentPayments = [
      taxedRow({
        id: "pay-igst",
        originalAmount: 500_000,
        taxAmount: 90_000,
        isInternational: true, // a fail-closed export at the same 18%
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ];

    const result = await createApprovalPaymentIntent(mintParams());

    expect(result.paymentIntentId).toBe("order_new");
    expect(mockedPaymentUpdate).toHaveBeenCalledTimes(1);
    expect(mockedPaymentUpdate.mock.calls[0][0].data.isInternational).toBe(
      false,
    );
  });

  // CodeRabbit r2 — a capture landing between the pre-read and the re-mint
  // must not be reset to PENDING under a replaced order.
  it("a re-mint that loses its CAS to a capture tombstones the new order and reports the row paid", async () => {
    state.appointmentPayments = [
      {
        id: "pay-racing",
        paymentStatus: PaymentStatus.PENDING,
        paymentIntent: "order_racing",
        amount: 500_000,
        currency: Currency.INR,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    state.remintCasCount = 0;
    state.remintFreshRow = {
      paymentStatus: PaymentStatus.SUCCEEDED,
      paymentIntent: "order_racing",
      amount: 500_000,
      currency: Currency.INR,
    };

    await expect(createApprovalPaymentIntent(mintParams())).rejects.toThrow(
      /already been paid/,
    );
    expect(mockedLegUpdate).not.toHaveBeenCalled();
    expect(mockTombstone).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntent: "order_new" }),
    );
  });

  it("a re-mint that loses its CAS to another mint hands back that mint's live link", async () => {
    state.appointmentPayments = [
      {
        id: "pay-racing",
        paymentStatus: PaymentStatus.PENDING,
        paymentIntent: "order_racing",
        amount: 500_000,
        currency: Currency.INR,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    state.remintCasCount = 0;
    state.remintFreshRow = {
      paymentStatus: PaymentStatus.PENDING,
      paymentIntent: "order_theirs",
      amount: TAXED_PLAN_PAISE,
      currency: Currency.INR,
    };

    const result = await createApprovalPaymentIntent(mintParams());

    expect(result).toEqual({
      paymentIntentId: "order_theirs",
      checkoutUrl: "order_theirs",
      amount: TAXED_PLAN_PAISE,
      currency: Currency.INR,
    });
    expect(mockTombstone).toHaveBeenCalledTimes(1);
  });

  it("refuses when the appointment's payment already SUCCEEDED", async () => {
    state.appointmentPayments = [
      {
        paymentStatus: PaymentStatus.SUCCEEDED,
        paymentIntent: "order_paid",
        amount: 500_000,
        currency: Currency.INR,
      },
    ];

    await expect(createApprovalPaymentIntent(mintParams())).rejects.toThrow(
      /already been paid/,
    );
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
  });

  // #1319 review — an EXPIRED row is re-minted INTO, never duplicated: Payment
  // is unique on [userId, appointmentId], so a second create dies on P2002.
  it("re-mints a dead intent into the same Payment row", async () => {
    state.appointmentPayments = [
      {
        id: "pay-dead",
        paymentStatus: PaymentStatus.EXPIRED,
        paymentIntent: "order_dead",
        amount: 500_000,
        currency: Currency.INR,
        expiresAt: null,
      },
    ];

    const result = await createApprovalPaymentIntent(mintParams());

    expect(result.paymentIntentId).toBe("order_new");
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
    expect(mockedPaymentUpdate).toHaveBeenCalledTimes(1);
    const [{ where, data }] = mockedPaymentUpdate.mock.calls[0];
    expect(where).toEqual({
      id: "pay-dead",
      paymentStatus: PaymentStatus.EXPIRED,
      paymentIntent: "order_dead",
    });
    expect(data.paymentIntent).toBe("order_new");
    expect(data.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("re-mints a PENDING intent that is past its own window", async () => {
    state.appointmentPayments = [
      {
        id: "pay-lapsed",
        paymentStatus: PaymentStatus.PENDING,
        paymentIntent: "order_lapsed",
        amount: 500_000,
        currency: Currency.INR,
        expiresAt: new Date(Date.now() - 60_000),
      },
    ];

    const result = await createApprovalPaymentIntent(mintParams());

    expect(result.paymentIntentId).toBe("order_new");
    expect(mockedPaymentUpdate).toHaveBeenCalledTimes(1);
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
  });

  it("refuses instead of re-minting once the sweep has moved the request on", async () => {
    state.consultationStatus = AppointmentStatus.REJECTED;
    state.appointmentPayments = [
      {
        id: "pay-dead",
        paymentStatus: PaymentStatus.EXPIRED,
        paymentIntent: "order_dead",
        amount: 500_000,
        currency: Currency.INR,
        expiresAt: null,
      },
    ];

    await expect(createApprovalPaymentIntent(mintParams())).rejects.toThrow(
      ApprovalWindowLapsedError,
    );
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockedPaymentUpdate).not.toHaveBeenCalled();
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
  });

  // CodeRabbit triage — the trial arm of findExistingLivePayment returned
  // the Trial's payment UNFILTERED, so an EXPIRED order would have
  // been handed back as a "reusable" checkout link (a dead intent) instead
  // of minting fresh.
  it("trial arm: an EXPIRED trial payment is re-minted into its own row", async () => {
    state.trialPayment = {
      id: "pay-trial-dead",
      paymentStatus: PaymentStatus.EXPIRED,
      paymentIntent: "order_trial_dead",
      amount: 250_000,
      currency: Currency.INR,
      expiresAt: null,
    };

    await createApprovalPaymentIntent({
      ...mintParams(),
      appointmentType: "TRIAL" as never,
      consultationId: undefined,
      trialId: "trial-1",
    } as never);

    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
    expect(mockedPaymentUpdate.mock.calls[0][0].where).toMatchObject({
      id: "pay-trial-dead",
    });
  });

  it("trial arm: a PENDING trial payment is reused, not duplicated", async () => {
    state.trialPayment = {
      paymentStatus: PaymentStatus.PENDING,
      paymentIntent: "order_trial_live",
      amount: 295_000, // ₹2,500 trial plus 18% GST
      originalAmount: 250_000,
      taxAmount: 45_000,
      isInternational: false,
      buyerCountry: "IN",
      currency: Currency.INR,
    };

    const result = await createApprovalPaymentIntent({
      ...mintParams(),
      appointmentType: "TRIAL" as never,
      consultationId: undefined,
      trialId: "trial-1",
    } as never);

    expect(result.paymentIntentId).toBe("order_trial_live");
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
  });
});

// #1583 C-P0-01 — the pay-link charged the pre-tax list price while checkout
// charged list plus GST, so the same plan cost 18% less through approval and
// the platform ate the tax. The mint now calls the one price derivation.
describe("approval pay-links charge the same tax as checkout (#1583 C-P0-01)", () => {
  beforeEach(() => {
    state.consultationPlan = {
      title: "Career Clarity",
      price: 100_000,
      priceCurrency: Currency.INR,
    };
  });

  it("an IN buyer pays ₹1,000 plus 18% GST, and the CARD leg carries the taxed figure", async () => {
    state.user = {
      id: CUID,
      country: "IN",
      consulteeProfile: { id: "consultee-1" },
    };

    const result = await createApprovalPaymentIntent(mintParams());

    expect(result.amount).toBe(118_000);
    const created = mockedPaymentCreate.mock.calls[0][0].data;
    expect(created).toMatchObject({
      amount: 118_000,
      originalAmount: 100_000,
      taxAmount: 18_000,
      isInternational: false,
      buyerCountry: "IN",
    });
    expect(created.legs.create.amountPaise).toBe(118_000);
    // The gateway is asked for the taxed figure, and the order notes carry it.
    const intentArg = mockCreatePaymentIntent.mock.calls[0][0];
    expect(intentArg.amount).toBe(118_000);
    expect(intentArg.metadata.taxAmount).toBe("18000");
  });

  it("a non-IN buyer under a valid LUT is zero-rated and flagged international", async () => {
    lutValid = true;
    state.user = {
      id: CUID,
      country: "GB",
      consulteeProfile: { id: "consultee-1" },
    };

    await createApprovalPaymentIntent(mintParams());

    expect(mockedPaymentCreate.mock.calls[0][0].data).toMatchObject({
      amount: 100_000,
      originalAmount: 100_000,
      taxAmount: 0,
      isInternational: true,
      buyerCountry: "GB",
    });
  });

  it("a ₹0 base derives 0/0/0 — the derivation adds no tax to nothing", async () => {
    // The mint itself still refuses a free trial before pricing it (the accept
    // path schedules those directly); this pins the derivation the mint shares.
    const derived = await deriveCheckoutAmount({
      basePaise: 0,
      buyerCountry: "IN",
    });
    expect(derived).toMatchObject({
      amount: 0,
      originalAmount: 0,
      taxAmount: 0,
    });
  });

  // #1589 T-P0-02 — a concurrent double-accept: the loser's create dies on
  // Payment's [userId, appointmentId] unique and must surface as a 409.
  it("maps the unique-pair P2002 on create to ApprovalPaymentExistsError and tombstones the minted order", async () => {
    mockedPaymentCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["userId", "appointmentId"] },
      }),
    );

    await expect(createApprovalPaymentIntent(mintParams())).rejects.toThrow(
      ApprovalPaymentExistsError,
    );
    // The gateway order was already minted; a late capture on it needs a
    // row to be refunded against, so the loser leaves the #1695 tombstone.
    expect(mockTombstone).toHaveBeenCalledTimes(1);
    expect(mockTombstone.mock.calls[0][0]).toMatchObject({
      paymentIntent: "order_new",
      userId: CUID,
      amount: 118_000,
      originalAmount: 100_000,
      taxAmount: 18_000,
    });
  });

  // CodeRabbit r2 — without the tombstone row there is nothing for a late
  // capture to land on, so the settled 409 is not honest; the original error
  // keeps the caller's retryable 502 alive instead.
  it("rethrows the original P2002 when the tombstone could not be persisted", async () => {
    const collision = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["userId", "appointmentId"] },
    });
    mockedPaymentCreate.mockRejectedValueOnce(collision);
    mockTombstone.mockResolvedValueOnce(false);

    await expect(createApprovalPaymentIntent(mintParams())).rejects.toBe(
      collision,
    );
  });

  // CodeRabbit r2 — a stored price outside the safe-integer range is refused
  // before it is priced, not silently rounded.
  it("refuses a plan price outside the safe-integer range", async () => {
    state.consultationPlan = {
      title: "Career Clarity",
      price: BigInt("9007199254740993"),
      priceCurrency: Currency.INR,
    };

    await expect(createApprovalPaymentIntent(mintParams())).rejects.toThrow(
      /safe range/,
    );
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("rethrows a P2002 on any other unique unchanged, with no tombstone", async () => {
    const other = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["paymentIntent"] },
    });
    mockedPaymentCreate.mockRejectedValueOnce(other);

    await expect(createApprovalPaymentIntent(mintParams())).rejects.toBe(other);
    expect(mockTombstone).not.toHaveBeenCalled();
  });
});

describe("approval routes thread the appointment (source contract)", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  // #1775 B-9 — both request routes mint through the one shared post-commit
  // block; the request-time appointment (the subscription's ONE wrapper —
  // #1554, no `[0]` to pick) is threaded there.
  it("the shared approval mint passes the request-time appointment", () => {
    const src = read("lib/booking/approve-request.ts");
    const fn = src.slice(
      src.indexOf("export async function mintApprovalPaymentAfterCommit"),
    );
    expect(fn).toContain("appointmentId: row.appointment?.id ?? undefined");
    for (const rel of [
      "app/api/bookings/consultations/[consultationId]/route.ts",
      "app/api/bookings/subscriptions/[subscriptionId]/route.ts",
    ]) {
      expect(read(rel)).toContain("mintApprovalPaymentAfterCommit({");
    }
  });

  it('the metadata builder no longer carries the "pending" sentinel', () => {
    // Defect 17 — a behavioural assertion above proves the key is absent, but
    // the sentinel could come back as a different literal on the same line and
    // still pass it. Pin the source too so the revert is unmistakable.
    const src = read("lib/payments/operations/approval-payment.ts");
    expect(src).not.toContain('?? "pending"');
    expect(src).not.toContain('|| "pending"');
  });

  it("every approval mint site names appointmentId explicitly", () => {
    // The twin-prone default (leaving it unset) may only survive where no
    // appointment exists yet; the call sites must at least name the param.
    for (const rel of [
      "lib/booking/approve-request.ts",
      "app/api/trials/[trialId]/route.ts",
    ]) {
      expect(read(rel)).toMatch(/appointmentId:/);
    }
  });
});

// #1780 R-4 — both mint conflicts carry the registered business code.
it("types the exists and already-paid refusals with their codes", () => {
  expect(new ApprovalPaymentExistsError().code).toBe("PAYMENT_ALREADY_EXISTS");
  expect(new ApprovalAlreadyPaidError().code).toBe("ALREADY_PAID");
});
