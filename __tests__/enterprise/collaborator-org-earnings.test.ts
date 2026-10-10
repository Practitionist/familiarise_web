/**
 * @jest-environment node
 */

/**
 * A3 (Q3): per-collaborator HOST-org settlement.
 *
 * After the primary expert's OrganizationEarnings row is created,
 * `createEarningsFromPayment` loops every ACCEPTED collaborator and
 * creates a SEPARATE OrganizationEarnings row for each one whose
 * consultant profile has an active EXPERT membership at a HOST org.
 *
 * Independent collaborators (no HOST membership) get NO row — their
 * share is only on `ConsultantEarnings`.
 *
 * Same-org collisions (collab at the SAME org as the primary expert,
 * or two collabs at the same org) hit the
 * @@unique([paymentId, organizationId]) DB constraint. v1 strategy:
 * skip the duplicate insert, log a warning, leave the collaborator's
 * personal share intact via ConsultantEarnings.
 *
 * Pure-mock unit test — we mock the Prisma client and the
 * `calculateRevenueSplit` helper, then assert the captured
 * `tx.organizationEarnings.create` payloads.
 */

const ORG_LEARNPRO = "org-learnpro";
const ORG_ANOTHER = "org-another-agency";
const PRIMARY_PROFILE = "consultant-primary";
const COLLAB_HOST_PROFILE = "consultant-collab-hosted";
const COLLAB_INDEP_PROFILE = "consultant-collab-independent";
const COLLAB_SAME_ORG_PROFILE = "consultant-collab-same-org";
const PLAN_ID = "plan-webinar-1";
const PAYMENT_ID = "payment-1";

// We must mock these BEFORE importing earnings-service (which imports them).
jest.mock("../../lib/feature-flags", () => ({
  ENABLE_HOST_ORGS: true,
}));

jest.mock("../../lib/collaborators/service", () => ({
  calculateRevenueSplit: jest.fn(),
}));

jest.mock("../../lib/api/organizations/rate-card", () => ({
  resolveEffectiveRateCard: jest.fn(),
  // #1335 — settlement destructures this from the same module; a partial mock
  // leaves it undefined and every split throws before it resolves a card.
  isScopedRateCardResolutionEnabled: () => false,
}));

// #812 — this suite verifies the per-collaborator EARNINGS-split logic, not the
// double-entry journal. The booking posting is incidental and its mock payment
// amounts aren't designed to balance, so stub postLedgerTxn (the real balance
// invariant is covered by ledger-invariants.test.ts). Real exports (types,
// LedgerImbalanceError) are preserved.
jest.mock("../../lib/payments/ledger/post", () => ({
  ...jest.requireActual("../../lib/payments/ledger/post"),
  postLedgerTxn: jest
    .fn()
    .mockResolvedValue({ transactionId: "ltxn-stub", created: true }),
}));

// Capture every organizationEarnings.create and consultantEarnings.create payload across the suite.
type CapturedCreate = {
  organizationId: string;
  consultantProfileId?: string | null;
  role?: string;
  paymentId: string;
  grossAmountPaise: number;
  platformFeePaise: number;
  orgSharePaise: number;
  consultantSharePaise: number;
  rateCardIdApplied: string | null;
  platformBpsApplied: number | null;
  orgBpsApplied: number | null;
  consultantBpsApplied: number | null;
};

type CapturedConsultantCreate = {
  consultantProfileId: string;
  role: string;
  grossAmount: number;
  platformFeePaise: number;
  consultantSharePaise: number;
};

let capturedOrgEarnings: CapturedCreate[] = [];
let capturedConsultantEarnings: CapturedConsultantCreate[] = [];
let p2002Targets: Set<string> = new Set();

// Mock prisma — must respond to $transaction with a tx object whose
// methods proxy to the mock store.
jest.mock("../../lib/prisma", () => {
  const mockTx = {
    // B2C take rate: no fee schedule row (marketplace fallback), no waiver, no stored owner.
    platformFeeSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
    consultantFeeWaiver: { findFirst: jest.fn().mockResolvedValue(null) },
    expertCustomerRelationship: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    ledgerTransaction: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "ltxn-1" }),
    },
    ledgerAccount: {
      upsert: jest
        .fn()
        .mockImplementation(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
        })),
    },
    ledgerAccountBalance: { upsert: jest.fn().mockResolvedValue({}) },
    paymentLeg: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    consultantEarnings: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(
          async ({ data }: { data: CapturedConsultantCreate }) => {
            capturedConsultantEarnings.push(data);
            return {
              id: "earnings-" + capturedConsultantEarnings.length,
              ...data,
            };
          },
        ),
    },
    consultantProfile: {
      update: jest.fn().mockResolvedValue({}),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ status: "ACTIVE" }),
    },
    organizationInvoice: {
      count: jest.fn().mockResolvedValue(1),
    },
    organizationEarnings: {
      create: jest
        .fn()
        .mockImplementation(async ({ data }: { data: CapturedCreate }) => {
          const key = `${data.paymentId}::${data.organizationId}`;
          if (p2002Targets.has(key)) {
            const err = new Error("Unique constraint failed") as Error & {
              code: string;
              clientVersion: string;
              meta: Record<string, unknown>;
            };
            err.code = "P2002";
            err.clientVersion = "test";
            err.meta = { target: ["paymentId", "organizationId"] };
            const { Prisma } = jest.requireActual("@prisma/client");
            Object.setPrototypeOf(
              err,
              Prisma.PrismaClientKnownRequestError.prototype,
            );
            throw err;
          }
          capturedOrgEarnings.push(data);
          return { id: "org-earn-" + capturedOrgEarnings.length, ...data };
        }),
    },
    membership: {
      findFirst: jest.fn(),
    },
    webinarPlan: {
      findUnique: jest.fn().mockResolvedValue({ organizationId: null }),
    },
    classPlan: {
      findUnique: jest.fn().mockResolvedValue({ organizationId: null }),
    },
  };
  return {
    __esModule: true,
    default: {
      $transaction: jest
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
          return await fn(mockTx);
        }),
      __mockTx: mockTx,
    },
  };
});

import prisma from "@/lib/prisma";
import { calculateRevenueSplit } from "@/lib/collaborators/service";
import { resolveEffectiveRateCard } from "@/lib/api/organizations/rate-card";
import { createEarningsFromPayment } from "@/lib/payments/payouts/earnings-service";

const mockedTx = (
  prisma as unknown as {
    __mockTx: {
      membership: { findFirst: jest.Mock };
      consultantEarnings: { findFirst: jest.Mock; create: jest.Mock };
      organization: { findUnique: jest.Mock };
      organizationEarnings: { create: jest.Mock };
    };
  }
).__mockTx;

const mockedCalculateSplit = calculateRevenueSplit as jest.MockedFunction<
  typeof calculateRevenueSplit
>;
const mockedResolveRateCard = resolveEffectiveRateCard as jest.MockedFunction<
  typeof resolveEffectiveRateCard
>;

function makePayment(overrides: Partial<{ id: string; amount: number }> = {}) {
  return {
    id: overrides.id ?? PAYMENT_ID,
    amount: overrides.amount ?? 100_000,
    originalAmount: overrides.amount ?? 100_000,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    appointment: {
      consultantProfile: { id: PRIMARY_PROFILE },
      webinar: { webinarPlanId: PLAN_ID },
      class: null,
    },
  } as unknown as Parameters<typeof createEarningsFromPayment>[0]["payment"];
}

function setMembershipMap(
  map: Record<
    string,
    { orgId: string; payoutRecipient?: "SELF" | "ORGANIZATION" } | null
  >,
) {
  mockedTx.membership.findFirst.mockImplementation(
    async (args: { where: { consultantProfileId: string } }) => {
      const cfg = map[args.where.consultantProfileId];
      if (!cfg) return null;
      return {
        id: `mem-${args.where.consultantProfileId}`,
        rateCardOverrideId: null,
        payoutRecipient: cfg.payoutRecipient ?? "SELF",
        organization: { id: cfg.orgId },
      };
    },
  );
}

/** Standard rate card: 10% platform / 5% org / 85% consultant. */
function setStandardRateCard() {
  mockedResolveRateCard.mockImplementation((async (
    _tx: unknown,
    params: { orgId: string | null },
  ) => ({
    rateCardId: `rc-${params.orgId}`,
    platformBps: 1000,
    orgBps: 500,
    consultantBps: 8500,
    ownerOrgId: params.orgId,
    ownerContractId: null,
  })) as unknown as typeof resolveEffectiveRateCard);
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedOrgEarnings = [];
  capturedConsultantEarnings = [];
  p2002Targets = new Set();
  mockedTx.consultantEarnings.findFirst.mockResolvedValue(null);
  mockedTx.organization.findUnique.mockResolvedValue({ status: "ACTIVE" });
  mockedTx.organizationEarnings.create.mockImplementation(
    async ({ data }: { data: CapturedCreate }) => {
      const key = `${data.paymentId}::${data.organizationId}`;
      if (p2002Targets.has(key)) {
        const { Prisma } = jest.requireActual("@prisma/client");
        const err = new Error("Unique constraint failed") as Error & {
          code: string;
          clientVersion: string;
          meta: Record<string, unknown>;
        };
        err.code = "P2002";
        err.clientVersion = "test";
        err.meta = { target: ["paymentId", "organizationId"] };
        Object.setPrototypeOf(
          err,
          Prisma.PrismaClientKnownRequestError.prototype,
        );
        throw err;
      }
      capturedOrgEarnings.push(data);
      return { id: "org-earn-" + capturedOrgEarnings.length, ...data };
    },
  );
  setStandardRateCard();
});

describe("per-collaborator HOST-org earnings", () => {
  it("creates one OrgEarnings row per HOST-org collaborator (skips independents)", async () => {
    setMembershipMap({
      [PRIMARY_PROFILE]: { orgId: ORG_LEARNPRO },
      [COLLAB_HOST_PROFILE]: { orgId: ORG_ANOTHER },
      [COLLAB_INDEP_PROFILE]: null, // independent, no HOST membership
    });

    // Pre-fee gross slices sum to exact payment.originalAmount (100_000):
    // 50_000 owner + 30_000 hosted collab + 20_000 independent collab.
    mockedCalculateSplit.mockResolvedValue([
      { consultantProfileId: PRIMARY_PROFILE, share: 50_000, role: "OWNER" },
      {
        consultantProfileId: COLLAB_HOST_PROFILE,
        share: 30_000,
        role: "CO_HOST",
      },
      {
        consultantProfileId: COLLAB_INDEP_PROFILE,
        share: 20_000,
        role: "CO_HOST",
      },
    ]);

    await createEarningsFromPayment({
      payment: makePayment(),
      appointmentType: "WEBINAR",
    });

    // Expect 2 OrgEarnings rows: LearnPro (primary) + AnotherAgency (hosted collab).
    // Independent collab gets no org row.
    expect(capturedOrgEarnings).toHaveLength(2);

    const learnpro = capturedOrgEarnings.find(
      (r) => r.organizationId === ORG_LEARNPRO,
    );
    const anotherAgency = capturedOrgEarnings.find(
      (r) => r.organizationId === ORG_ANOTHER,
    );

    expect(learnpro).toBeDefined();
    expect(anotherAgency).toBeDefined();

    // Primary org settles owner's pre-fee gross slice (50_000) once through its 10/5/85 rate card:
    expect(learnpro).toMatchObject({
      grossAmountPaise: 50_000,
      platformFeePaise: 5_000,
      orgSharePaise: 2_500,
      consultantSharePaise: 42_500,
    });

    // Collab org settles collaborator's pre-fee gross slice (30_000) once through its 10/5/85 rate card:
    expect(anotherAgency).toMatchObject({
      grossAmountPaise: 30_000,
      platformFeePaise: 3_000,
      orgSharePaise: 1_500,
      consultantSharePaise: 25_500,
      rateCardIdApplied: `rc-${ORG_ANOTHER}`,
    });

    // Verify ConsultantEarnings rows also carry single-fee slice settlements:
    expect(capturedConsultantEarnings).toEqual([
      expect.objectContaining({
        consultantProfileId: PRIMARY_PROFILE,
        role: "OWNER",
        grossAmount: 50_000,
        platformFeePaise: 5_000,
        consultantSharePaise: 42_500,
      }),
      expect.objectContaining({
        consultantProfileId: COLLAB_HOST_PROFILE,
        role: "COLLABORATOR",
        grossAmount: 30_000,
        platformFeePaise: 3_000,
        consultantSharePaise: 25_500,
      }),
      expect.objectContaining({
        consultantProfileId: COLLAB_INDEP_PROFILE,
        role: "COLLABORATOR",
        grossAmount: 20_000,
        platformFeePaise: 4_000,
        consultantSharePaise: 16_000,
      }),
    ]);

    const independentRows = capturedOrgEarnings.filter((r) =>
      r.organizationId.includes("indep"),
    );
    expect(independentRows).toHaveLength(0);
  });

  it("creates separate OrganizationEarnings rows when collaborator shares the primary expert's org (keyed by consultantProfileId + role)", async () => {
    setMembershipMap({
      [PRIMARY_PROFILE]: { orgId: ORG_LEARNPRO },
      [COLLAB_SAME_ORG_PROFILE]: { orgId: ORG_LEARNPRO }, // same org as primary
    });

    mockedCalculateSplit.mockResolvedValue([
      { consultantProfileId: PRIMARY_PROFILE, share: 75_000, role: "OWNER" },
      {
        consultantProfileId: COLLAB_SAME_ORG_PROFILE,
        share: 25_000,
        role: "CO_HOST",
      },
    ]);

    await createEarningsFromPayment({
      payment: makePayment(),
      appointmentType: "WEBINAR",
    });

    // Both the primary expert and the same-org collaborator receive distinct
    // OrganizationEarnings rows keyed by (paymentId, organizationId, consultantProfileId, role),
    // each settling its own pre-fee gross slice once.
    expect(capturedOrgEarnings).toHaveLength(2);
    expect(capturedOrgEarnings[0]).toMatchObject({
      organizationId: ORG_LEARNPRO,
      consultantProfileId: PRIMARY_PROFILE,
      role: "OWNER",
      grossAmountPaise: 75_000,
      platformFeePaise: 7_500,
      orgSharePaise: 3_750,
      consultantSharePaise: 63_750,
    });
    expect(capturedOrgEarnings[1]).toMatchObject({
      organizationId: ORG_LEARNPRO,
      consultantProfileId: COLLAB_SAME_ORG_PROFILE,
      role: "COLLABORATOR",
      grossAmountPaise: 25_000,
      platformFeePaise: 2_500,
      orgSharePaise: 1_250,
      consultantSharePaise: 21_250,
    });
  });

  it("creates an OrgEarnings row when the primary expert is independent but a collaborator IS at a HOST org", async () => {
    // Primary independent → no OWNER OrganizationEarnings, but the
    // collaborator's HOST membership still drives a per-collab row.
    setMembershipMap({
      [PRIMARY_PROFILE]: null, // independent owner
      [COLLAB_HOST_PROFILE]: { orgId: ORG_ANOTHER },
    });

    mockedCalculateSplit.mockResolvedValue([
      { consultantProfileId: PRIMARY_PROFILE, share: 70_000, role: "OWNER" },
      {
        consultantProfileId: COLLAB_HOST_PROFILE,
        share: 30_000,
        role: "CO_HOST",
      },
    ]);

    await createEarningsFromPayment({
      payment: makePayment(),
      appointmentType: "WEBINAR",
    });

    expect(capturedOrgEarnings).toHaveLength(1);
    expect(capturedOrgEarnings[0].organizationId).toBe(ORG_ANOTHER);
    expect(capturedOrgEarnings[0].grossAmountPaise).toBe(30_000);
    expect(capturedOrgEarnings[0].platformFeePaise).toBe(3_000);
    expect(capturedOrgEarnings[0].orgSharePaise).toBe(1_500);
    expect(capturedOrgEarnings[0].consultantSharePaise).toBe(25_500);
  });

  it("skips zero-share collaborators (defensive — no 0-paise org rows)", async () => {
    setMembershipMap({
      [PRIMARY_PROFILE]: { orgId: ORG_LEARNPRO },
      [COLLAB_HOST_PROFILE]: { orgId: ORG_ANOTHER },
    });

    mockedCalculateSplit.mockResolvedValue([
      { consultantProfileId: PRIMARY_PROFILE, share: 100_000, role: "OWNER" },
      { consultantProfileId: COLLAB_HOST_PROFILE, share: 0, role: "CO_HOST" }, // zeroed out
    ]);

    await createEarningsFromPayment({
      payment: makePayment(),
      appointmentType: "WEBINAR",
    });

    // Only the primary org row — collab share=0 short-circuits before
    // resolveOrgSplit is even called.
    expect(capturedOrgEarnings).toHaveLength(1);
    expect(capturedOrgEarnings[0].organizationId).toBe(ORG_LEARNPRO);
  });
});
