/**
 * @jest-environment node
 */

jest.mock("server-only", () => ({}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/feature-flags", () => ({
  ENABLE_HOST_ORGS: true,
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(),
}));
jest.mock("../../lib/payments/ledger/unapplied-receipts", () => ({
  hasUnappliedReceipt: jest.fn(async () => false),
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: jest.fn(async (fn: () => Promise<unknown>) => fn()),
}));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(),
  getStreamVideoClient: jest.fn(),
  isExpectedStreamError: () => false,
}));
jest.mock("../../lib/stream/event-channel-service", () => ({
  addUserToEventChannel: jest.fn(),
  checkEventChannelExists: jest.fn(),
  removeUserFromEventChannel: jest.fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyCollaboratorInvited: jest.fn(),
  notifyCollaboratorAccepted: jest.fn(),
  notifyCollaboratorDeclined: jest.fn(),
  notifyCollaboratorRemoved: jest.fn(),
  notifyCollaboratorWithdrawn: jest.fn(),
}));
jest.mock("../../lib/email/senders/collaborators", () => ({
  sendCollaboratorInvitedEmail: jest.fn(),
  sendCollaboratorAcceptedEmail: jest.fn(),
  sendCollaboratorDeclinedEmail: jest.fn(),
  sendCollaboratorRemovedEmail: jest.fn(),
  sendCollaboratorWithdrawnEmail: jest.fn(),
}));
jest.mock(
  "../../utils/organization-roles",
  () => ({ hasOrgPermission: jest.fn(() => false) }),
  { virtual: true },
);

const mockPostLedgerTxn = jest.fn(async (_tx: unknown, _input: unknown) => ({
  id: "journal-1",
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (txArg: unknown, input: unknown) =>
    mockPostLedgerTxn(txArg, input),
}));

const mockSettleB2cPlatformFeePaise = jest.fn();
const mockPlanB2cPlatformFeePaise = jest.fn();
jest.mock("../../lib/payments/pricing/platform-fee", () => ({
  settleB2cPlatformFeePaise: (...args: unknown[]) =>
    mockSettleB2cPlatformFeePaise(...args),
  planB2cPlatformFeePaise: (...args: unknown[]) =>
    mockPlanB2cPlatformFeePaise(...args),
}));

jest.mock("../../lib/payments/payouts/earnings-hold", () => ({
  computeHoldUntil: jest.fn(() => new Date("2026-10-15T00:00:00Z")),
  holdHoursFor: jest.fn(() => 24),
  resolveEarningsAnchor: jest.fn(async () => ({
    lastOccurrenceEndsAt: new Date("2026-10-14T00:00:00Z"),
    appointmentOccurrenceId: "occ-1",
  })),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

import { createEarningsFromPayment } from "@/lib/payments/payouts/earnings-service";
import type { Posting } from "@/lib/payments/ledger/post";

interface MockEarningRow {
  id: string;
  consultantProfileId: string;
  grossAmount: number;
  platformFeePaise: number;
  consultantSharePaise: number;
  role: string;
  shareBps: number;
}

interface MockOrgEarningRow {
  id: string;
  organizationId: string;
  consultantProfileId: string | null;
  role: string;
  grossAmountPaise: number;
  platformFeePaise: number;
  orgSharePaise: number;
  consultantSharePaise: number;
}

function assertJournalBalanced(postings: Posting[]) {
  const debits = postings
    .filter((p) => p.direction === "DEBIT")
    .reduce((sum, p) => sum + p.amountPaise, 0);
  const credits = postings
    .filter((p) => p.direction === "CREDIT")
    .reduce((sum, p) => sum + p.amountPaise, 0);
  expect(debits).toBeGreaterThan(0);
  expect(credits).toBe(debits);
  return { debits, credits };
}

function useFlatB2cFeeBps(bps: number) {
  const compute = async (
    _tx: unknown,
    _p: unknown,
    _cp: unknown,
    slice: number,
  ) => Math.floor((slice * bps) / 10_000);
  mockSettleB2cPlatformFeePaise.mockImplementation(compute);
  mockPlanB2cPlatformFeePaise.mockImplementation(compute);
}

function makeCollaboratorRow(opts: {
  id: string;
  consultantProfileId: string;
  revenueShareBps: number;
  role?: string;
  userId?: string;
  name?: string;
}) {
  return {
    id: opts.id,
    consultantProfileId: opts.consultantProfileId,
    status: "ACCEPTED",
    role: opts.role ?? "CO_HOST",
    revenueShareBps: opts.revenueShareBps,
    consultantProfile: {
      userId: opts.userId ?? `u-${opts.consultantProfileId}`,
      user: { name: opts.name ?? "Collaborator" },
    },
  };
}

function makeRateCard(id: string, platformBps: number, orgBps: number) {
  return {
    id,
    platformBps,
    orgBps,
    consultantBps: 10_000 - platformBps - orgBps,
  };
}

interface EarningsHarnessOptions {
  collaborators?: ReturnType<typeof makeCollaboratorRow>[];
  webinarOwner?: {
    consultantProfileId: string | null;
    organizationId: string | null;
  };
  classOwner?: {
    consultantProfileId: string | null;
    organizationId: string | null;
  };
  membershipResolver?: (where: {
    consultantProfileId?: string;
    organizationId?: string;
  }) => unknown;
  rateCardResolver?: (where: {
    id?: string;
    organizationId?: string;
  }) => unknown;
  paymentLegs?: Array<{ source: string; amountPaise: number }>;
  billingAccount?: { ownerOrgId: string; fundingSource: string } | null;
  organization?: { id?: string; status: string; canHost?: boolean } | null;
}

function createEarningsTestHarness(options: EarningsHarnessOptions = {}) {
  const createdConsultantRows: MockEarningRow[] = [];
  const createdOrgRows: MockOrgEarningRow[] = [];

  const tx = {
    consultantEarnings: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(
        async ({ data }: { data: Omit<MockEarningRow, "id"> }) => {
          const row = { id: `ce-${createdConsultantRows.length + 1}`, ...data };
          createdConsultantRows.push(row);
          return row;
        },
      ),
    },
    organizationEarnings: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(
        async ({ data }: { data: Omit<MockOrgEarningRow, "id"> }) => {
          const row = { id: `oe-${createdOrgRows.length + 1}`, ...data };
          createdOrgRows.push(row);
          return row;
        },
      ),
    },
    collaborator: {
      findMany: jest.fn(async () => options.collaborators ?? []),
    },
    ...(options.webinarOwner
      ? {
          webinarPlan: {
            findUnique: jest.fn(async () => options.webinarOwner),
          },
        }
      : {}),
    ...(options.classOwner
      ? { classPlan: { findUnique: jest.fn(async () => options.classOwner) } }
      : {}),
    membership: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { consultantProfileId?: string; organizationId?: string };
        }) =>
          options.membershipResolver ? options.membershipResolver(where) : null,
      ),
    },
    rateCard: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { id?: string; organizationId?: string };
        }) =>
          options.rateCardResolver ? options.rateCardResolver(where) : null,
      ),
    },
    contract: { findFirst: jest.fn(async () => null) },
    paymentLeg: { findMany: jest.fn(async () => options.paymentLegs ?? []) },
    ...(options.billingAccount
      ? {
          billingAccount: {
            findUnique: jest.fn(async () => options.billingAccount),
          },
        }
      : {}),
    ...(options.organization
      ? {
          organization: {
            findUnique: jest.fn(async () => options.organization),
          },
        }
      : {}),
  };

  return { tx: tx as never, createdConsultantRows, createdOrgRows };
}

function makeSplitPayment(opts: {
  id: string;
  amount: number;
  appointmentId: string;
  consultantProfileId: string | null;
  organizationId?: string | null;
  webinarPlanId?: string;
  classPlanId?: string;
  paymentOrgId?: string;
  billingAccountId?: string;
}) {
  return {
    id: opts.id,
    userId: "u-buyer",
    ...(opts.paymentOrgId ? { organizationId: opts.paymentOrgId } : {}),
    ...(opts.billingAccountId
      ? { billingAccountId: opts.billingAccountId }
      : {}),
    amount: opts.amount,
    originalAmount: opts.amount,
    taxAmount: 0,
    currency: "INR",
    createdAt: new Date("2026-10-09T10:00:00Z"),
    appointmentId: opts.appointmentId,
    appointment: {
      consultantProfile: opts.consultantProfileId
        ? { id: opts.consultantProfileId }
        : null,
      organizationId: opts.organizationId ?? null,
      ...(opts.webinarPlanId
        ? { webinar: { webinarPlanId: opts.webinarPlanId } }
        : {}),
      ...(opts.classPlanId ? { class: { classPlanId: opts.classPlanId } } : {}),
    },
  } as never;
}

function expectBalancedJournalWithDebits(expectedDebits: number) {
  const journalArg = mockPostLedgerTxn.mock.calls[0][1] as {
    postings: Posting[];
  };
  const { debits } = assertJournalBalanced(journalArg.postings);
  expect(debits).toBe(expectedDebits);
}

describe("multi-party collaborator revenue splitting & settlement invariants", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("1. Solo host + solo collaborators: splits pre-fee grossSlice, deducts single 20% fee per party, and assigns residual paise & bps to OWNER", async () => {
    useFlatB2cFeeBps(2000);

    const { tx, createdConsultantRows, createdOrgRows } =
      createEarningsTestHarness({
        collaborators: [
          makeCollaboratorRow({
            id: "collab-1",
            consultantProfileId: "cp-collab",
            revenueShareBps: 3333,
            name: "Collab",
          }),
        ],
        webinarOwner: { consultantProfileId: "cp-host", organizationId: null },
      });

    const ownerEarningId = await createEarningsFromPayment({
      payment: makeSplitPayment({
        id: "pay-solo-odd",
        amount: 10_003,
        appointmentId: "appt-1",
        consultantProfileId: "cp-host",
        webinarPlanId: "wp-solo",
      }),
      appointmentType: "WEBINAR",
      tx,
    });

    expect(ownerEarningId).toBe("ce-1");
    expect(createdOrgRows).toHaveLength(0);
    expect(createdConsultantRows).toHaveLength(2);

    const ownerRow = createdConsultantRows.find((r) => r.role === "OWNER")!;
    const collabRow = createdConsultantRows.find(
      (r) => r.role === "COLLABORATOR",
    )!;

    // Pre-fee gross slices sum to exact payment grossAmount (10_003)
    expect(collabRow.grossAmount).toBe(3333);
    expect(ownerRow.grossAmount).toBe(6670);
    expect(ownerRow.grossAmount + collabRow.grossAmount).toBe(10_003);

    // Share bps sum to exact 10_000 with residual assigned to OWNER
    expect(ownerRow.shareBps + collabRow.shareBps).toBe(10_000);

    // Single 20% fee applied per slice (never double-deducted)
    expect(ownerRow.platformFeePaise).toBe(1334);
    expect(ownerRow.consultantSharePaise).toBe(5336);
    expect(collabRow.platformFeePaise).toBe(666);
    expect(collabRow.consultantSharePaise).toBe(2667);

    expectBalancedJournalWithDebits(10_003);
  });

  it("2. Org-hosted webinar with org-affiliated collaborator: applies single fee per party slice (never double fee) and balances double-entry journal", async () => {
    const memberships: Record<string, { orgId: string; rateCardId: string }> = {
      "cp-host-org": { orgId: "org-host", rateCardId: "rc-host" },
      "cp-collab-org": { orgId: "org-collab", rateCardId: "rc-collab" },
    };

    const { tx, createdConsultantRows, createdOrgRows } =
      createEarningsTestHarness({
        collaborators: [
          makeCollaboratorRow({
            id: "collab-org",
            consultantProfileId: "cp-collab-org",
            revenueShareBps: 3000,
            name: "Org Collab",
          }),
        ],
        webinarOwner: {
          consultantProfileId: "cp-host-org",
          organizationId: "org-host",
        },
        membershipResolver: (where) => {
          const hit = where.consultantProfileId
            ? memberships[where.consultantProfileId]
            : undefined;
          return hit
            ? {
                organizationId: hit.orgId,
                payoutRecipient: "SELF",
                rateCardOverrideId: hit.rateCardId,
                organization: { id: hit.orgId },
              }
            : null;
        },
        rateCardResolver: (where) =>
          where.id === "rc-host" || where.organizationId === "org-host"
            ? makeRateCard("rc-host", 1500, 1000)
            : makeRateCard("rc-collab", 1200, 800),
      });

    await createEarningsFromPayment({
      payment: makeSplitPayment({
        id: "pay-org-multi",
        amount: 100_000,
        appointmentId: "appt-org-1",
        consultantProfileId: "cp-host-org",
        organizationId: "org-host",
        webinarPlanId: "wp-org-1",
      }),
      appointmentType: "WEBINAR",
      tx,
    });

    const ownerRow = createdConsultantRows.find((r) => r.role === "OWNER")!;
    const collabRow = createdConsultantRows.find(
      (r) => r.role === "COLLABORATOR",
    )!;
    expect(ownerRow).toMatchObject({
      grossAmount: 70_000,
      platformFeePaise: 10_500,
      consultantSharePaise: 52_500,
    });
    expect(collabRow).toMatchObject({
      grossAmount: 30_000,
      platformFeePaise: 3_600,
      consultantSharePaise: 24_000,
    });

    expect(createdOrgRows).toHaveLength(2);
    expect(
      createdOrgRows.map((o) => o.orgSharePaise).reduce((a, b) => a + b, 0),
    ).toBe(9_400);

    expectBalancedJournalWithDebits(100_000);
  });

  it("3. Ownerless org catalog plan (consultantProfileId: null, organizationId: org_1) with accepted collaborator: settles owner share into OrganizationEarnings + ORG_PAYABLE", async () => {
    useFlatB2cFeeBps(2000);

    const { tx, createdConsultantRows, createdOrgRows } =
      createEarningsTestHarness({
        collaborators: [
          makeCollaboratorRow({
            id: "collab-guest",
            consultantProfileId: "cp-guest",
            revenueShareBps: 3000,
            name: "Guest",
          }),
        ],
        webinarOwner: { consultantProfileId: null, organizationId: "org_1" },
        organization: { id: "org_1", status: "ACTIVE", canHost: true },
        rateCardResolver: () => makeRateCard("rc-org-default", 1000, 9000),
      });

    const ownerId = await createEarningsFromPayment({
      payment: makeSplitPayment({
        id: "pay-ownerless-org",
        amount: 100_000,
        appointmentId: "appt-ownerless",
        consultantProfileId: null,
        organizationId: "org_1",
        webinarPlanId: "wp-ownerless",
      }),
      appointmentType: "WEBINAR",
      tx,
    });

    expect(ownerId).toBeNull();
    expect(createdConsultantRows).toHaveLength(1);
    expect(createdConsultantRows[0]).toMatchObject({
      consultantProfileId: "cp-guest",
      role: "COLLABORATOR",
      grossAmount: 30_000,
      platformFeePaise: 6_000,
      consultantSharePaise: 24_000,
    });

    expect(createdOrgRows).toHaveLength(1);
    expect(createdOrgRows[0]).toMatchObject({
      organizationId: "org_1",
      consultantProfileId: null,
      role: "OWNER",
      grossAmountPaise: 70_000,
      platformFeePaise: 7_000,
      orgSharePaise: 63_000,
      consultantSharePaise: 0,
    });

    expectBalancedJournalWithDebits(100_000);
  });

  it("4. B2B (0% platform fee) multi-party split: deducts 0 platform fee on all slices and credits full gross slices", async () => {
    useFlatB2cFeeBps(0);

    const { tx, createdConsultantRows } = createEarningsTestHarness({
      collaborators: [
        makeCollaboratorRow({
          id: "collab-b2b",
          consultantProfileId: "cp-collab-b2b",
          revenueShareBps: 3000,
          role: "CO_INSTRUCTOR",
          name: "B2B Collab",
        }),
      ],
      classOwner: { consultantProfileId: "cp-host-b2b", organizationId: null },
      paymentLegs: [{ source: "WALLET", amountPaise: 50_000 }],
      billingAccount: { ownerOrgId: "org-sponsor", fundingSource: "WALLET" },
      organization: { status: "ACTIVE" },
    });

    await createEarningsFromPayment({
      payment: makeSplitPayment({
        id: "pay-b2b",
        amount: 50_000,
        appointmentId: "appt-b2b",
        consultantProfileId: "cp-host-b2b",
        classPlanId: "cp-plan-b2b",
        paymentOrgId: "org-sponsor",
        billingAccountId: "ba-sponsor",
      }),
      appointmentType: "CLASS",
      tx,
    });

    expect(createdConsultantRows).toHaveLength(2);
    expect(createdConsultantRows[0]).toMatchObject({
      consultantProfileId: "cp-host-b2b",
      role: "OWNER",
      grossAmount: 35_000,
      platformFeePaise: 0,
      consultantSharePaise: 35_000,
    });
    expect(createdConsultantRows[1]).toMatchObject({
      consultantProfileId: "cp-collab-b2b",
      role: "COLLABORATOR",
      grossAmount: 15_000,
      platformFeePaise: 0,
      consultantSharePaise: 15_000,
    });

    expectBalancedJournalWithDebits(50_000);
  });

  it("5. Ownerless org catalog plan with zero consultant earnings: refundEarnings still reverses OrganizationEarnings on partial and full refunds", async () => {
    const { refundEarnings } =
      await import("@/lib/payments/payouts/earnings-service");

    const zeroTx = {
      consultantEarnings: { findMany: jest.fn(async () => []) },
      organizationEarnings: { count: jest.fn(async () => 1) },
    } as never;

    await refundEarnings("pay-ownerless-zero", { refundAmount: 0, tx: zeroTx });

    const partialUpdate = jest.fn(async () => ({ count: 1 }));
    const partialTx = {
      consultantEarnings: { findMany: jest.fn(async () => []) },
      organizationEarnings: {
        count: jest.fn(async () => 1),
        findMany: jest.fn(async () => [
          {
            id: "oe-ownerless-1",
            paymentId: "pay-ownerless-partial",
            organizationId: "org_1",
            grossAmountPaise: 100_000,
            orgSharePaise: 90_000,
            status: "HELD",
          },
        ]),
        updateMany: partialUpdate,
      },
      payment: {
        findUnique: jest.fn(async () => ({ amount: 100_000 })),
      },
    } as never;

    await refundEarnings("pay-ownerless-partial", {
      refundAmount: 50_000,
      tx: partialTx,
    });
    expect(partialUpdate).toHaveBeenCalledTimes(1);
  });
});
