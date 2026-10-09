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

describe("multi-party collaborator revenue splitting & settlement invariants", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("1. Solo host + solo collaborators: splits pre-fee grossSlice, deducts single 20% fee per party, and assigns residual paise & bps to OWNER", async () => {
    mockSettleB2cPlatformFeePaise.mockImplementation(
      async (_tx: unknown, _p: unknown, _cp: unknown, slice: number) =>
        Math.floor((slice * 2000) / 10_000),
    );
    mockPlanB2cPlatformFeePaise.mockImplementation(
      async (_tx: unknown, _p: unknown, _cp: unknown, slice: number) =>
        Math.floor((slice * 2000) / 10_000),
    );

    const createdConsultantRows: MockEarningRow[] = [];
    const createdOrgRows: MockOrgEarningRow[] = [];

    const tx = {
      consultantEarnings: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(
          async ({ data }: { data: Omit<MockEarningRow, "id"> }) => {
            const row = {
              id: `ce-${createdConsultantRows.length + 1}`,
              ...data,
            };
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
        findMany: jest.fn(async () => [
          {
            id: "collab-1",
            consultantProfileId: "cp-collab",
            status: "ACCEPTED",
            role: "CO_HOST",
            revenueShareBps: 3333, // 33.33% on odd gross 10_003 -> 3333 slice, owner gets 6670
            consultantProfile: { userId: "u-collab", user: { name: "Collab" } },
          },
        ]),
      },
      webinarPlan: {
        findUnique: jest.fn(async () => ({
          consultantProfileId: "cp-host",
          organizationId: null,
        })),
      },
      membership: { findFirst: jest.fn(async () => null) },
      rateCard: { findFirst: jest.fn(async () => null) },
      contract: { findFirst: jest.fn(async () => null) },
      paymentLeg: { findMany: jest.fn(async () => []) },
    };

    const ownerEarningId = await createEarningsFromPayment({
      payment: {
        id: "pay-solo-odd",
        userId: "u-buyer",
        amount: 10_003,
        originalAmount: 10_003,
        taxAmount: 0,
        currency: "INR",
        createdAt: new Date("2026-10-09T10:00:00Z"),
        appointmentId: "appt-1",
        appointment: {
          consultantProfile: { id: "cp-host" },
          organizationId: null,
          webinar: { webinarPlanId: "wp-solo" },
        },
      } as never,
      appointmentType: "WEBINAR",
      tx: tx as never,
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

    // Verify exact double-entry journal balance
    const journalArg = mockPostLedgerTxn.mock.calls[0][1] as {
      postings: Posting[];
    };
    const { debits } = assertJournalBalanced(journalArg.postings);
    expect(debits).toBe(10_003);
  });

  it("2. Org-hosted webinar with org-affiliated collaborator: applies single fee per party slice (never double fee) and balances double-entry journal", async () => {
    const createdConsultantRows: MockEarningRow[] = [];
    const createdOrgRows: MockOrgEarningRow[] = [];

    const tx = {
      consultantEarnings: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(
          async ({ data }: { data: Omit<MockEarningRow, "id"> }) => {
            const row = {
              id: `ce-${createdConsultantRows.length + 1}`,
              ...data,
            };
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
        findMany: jest.fn(async () => [
          {
            id: "collab-org",
            consultantProfileId: "cp-collab-org",
            status: "ACCEPTED",
            role: "CO_HOST",
            revenueShareBps: 3000, // 30% gross slice = 30_000
            consultantProfile: {
              userId: "u-collab-org",
              user: { name: "Org Collab" },
            },
          },
        ]),
      },
      webinarPlan: {
        findUnique: jest.fn(async () => ({
          consultantProfileId: "cp-host-org",
          organizationId: "org-host",
        })),
      },
      membership: {
        findFirst: jest.fn(
          async ({
            where,
          }: {
            where: { consultantProfileId?: string; organizationId?: string };
          }) => {
            if (where.consultantProfileId === "cp-host-org") {
              return {
                organizationId: "org-host",
                payoutRecipient: "SELF",
                rateCardOverrideId: "rc-host",
                organization: { id: "org-host" },
              };
            }
            if (where.consultantProfileId === "cp-collab-org") {
              return {
                organizationId: "org-collab",
                payoutRecipient: "SELF",
                rateCardOverrideId: "rc-collab",
                organization: { id: "org-collab" },
              };
            }
            return null;
          },
        ),
      },
      rateCard: {
        findFirst: jest.fn(
          async ({
            where,
          }: {
            where: { id?: string; organizationId?: string };
          }) => {
            if (where.id === "rc-host" || where.organizationId === "org-host") {
              return {
                id: "rc-host",
                platformBps: 1500, // 15% fee
                orgBps: 1000, // 10% org
                consultantBps: 7500, // 75% consultant
              };
            }
            return {
              id: "rc-collab",
              platformBps: 1200, // 12% fee
              orgBps: 800, // 8% org
              consultantBps: 8000, // 80% consultant
            };
          },
        ),
      },
      paymentLeg: { findMany: jest.fn(async () => []) },
      contract: { findFirst: jest.fn(async () => null) },
    };

    await createEarningsFromPayment({
      payment: {
        id: "pay-org-multi",
        userId: "u-buyer",
        amount: 100_000,
        originalAmount: 100_000,
        taxAmount: 0,
        currency: "INR",
        createdAt: new Date("2026-10-09T10:00:00Z"),
        appointmentId: "appt-org-1",
        appointment: {
          consultantProfile: { id: "cp-host-org" },
          organizationId: "org-host",
          webinar: { webinarPlanId: "wp-org-1" },
        },
      } as never,
      appointmentType: "WEBINAR",
      tx: tx as never,
    });

    // Host slice = 70_000 -> fee 10_500, org 7_000, consultant 52_500
    // Collab slice = 30_000 -> fee 3_600, org 2_400, consultant 24_000
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

    // DEBIT (100_000) === PLATFORM_FEE (14_100) + CONSULTANT_PAYABLE (76_500) + ORG_PAYABLE (9_400)
    const journalArg = mockPostLedgerTxn.mock.calls[0][1] as {
      postings: Posting[];
    };
    const { debits } = assertJournalBalanced(journalArg.postings);
    expect(debits).toBe(100_000);
  });

  it("3. Ownerless org catalog plan (consultantProfileId: null, organizationId: org_1) with accepted collaborator: settles owner share into OrganizationEarnings + ORG_PAYABLE", async () => {
    mockPlanB2cPlatformFeePaise.mockImplementation(
      async (_tx: unknown, _p: unknown, _cp: unknown, slice: number) =>
        Math.floor((slice * 2000) / 10_000),
    );
    mockSettleB2cPlatformFeePaise.mockImplementation(
      async (_tx: unknown, _p: unknown, _cp: unknown, slice: number) =>
        Math.floor((slice * 2000) / 10_000),
    );

    const createdConsultantRows: MockEarningRow[] = [];
    const createdOrgRows: MockOrgEarningRow[] = [];

    const tx = {
      consultantEarnings: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(
          async ({ data }: { data: Omit<MockEarningRow, "id"> }) => {
            const row = {
              id: `ce-${createdConsultantRows.length + 1}`,
              ...data,
            };
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
        findMany: jest.fn(async () => [
          {
            id: "collab-guest",
            consultantProfileId: "cp-guest",
            status: "ACCEPTED",
            role: "CO_HOST",
            revenueShareBps: 3000, // 30% slice = 30_000
            consultantProfile: { userId: "u-guest", user: { name: "Guest" } },
          },
        ]),
      },
      webinarPlan: {
        findUnique: jest.fn(async () => ({
          consultantProfileId: null,
          organizationId: "org_1",
        })),
      },
      organization: {
        findUnique: jest.fn(async () => ({
          id: "org_1",
          status: "ACTIVE",
          canHost: true,
        })),
      },
      membership: { findFirst: jest.fn(async () => null) },
      rateCard: {
        findFirst: jest.fn(async () => ({
          id: "rc-org-default",
          platformBps: 1000, // 10% platform fee on ownerless org slice (70_000 -> fee 7_000, orgShare 63_000)
          orgBps: 9000,
          consultantBps: 0,
        })),
      },
      paymentLeg: { findMany: jest.fn(async () => []) },
      contract: { findFirst: jest.fn(async () => null) },
    };

    const ownerId = await createEarningsFromPayment({
      payment: {
        id: "pay-ownerless-org",
        userId: "u-buyer",
        amount: 100_000,
        originalAmount: 100_000,
        taxAmount: 0,
        currency: "INR",
        createdAt: new Date("2026-10-09T10:00:00Z"),
        appointmentId: "appt-ownerless",
        appointment: {
          consultantProfile: null,
          organizationId: "org_1",
          webinar: { webinarPlanId: "wp-ownerless" },
        },
      } as never,
      appointmentType: "WEBINAR",
      tx: tx as never,
    });

    // No ConsultantEarnings row is created for null owner; only collaborator gets ConsultantEarnings
    expect(ownerId).toBeNull();
    expect(createdConsultantRows).toHaveLength(1);
    expect(createdConsultantRows[0]).toMatchObject({
      consultantProfileId: "cp-guest",
      role: "COLLABORATOR",
      grossAmount: 30_000,
      platformFeePaise: 6_000,
      consultantSharePaise: 24_000,
    });

    // Ownerless org share settles cleanly into OrganizationEarnings
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

    const journalArg = mockPostLedgerTxn.mock.calls[0][1] as {
      postings: Posting[];
    };
    const { debits } = assertJournalBalanced(journalArg.postings);
    expect(debits).toBe(100_000);
  });

  it("4. B2B (0% platform fee) multi-party split: deducts 0 platform fee on all slices and credits full gross slices", async () => {
    mockSettleB2cPlatformFeePaise.mockResolvedValue(0);
    mockPlanB2cPlatformFeePaise.mockResolvedValue(0);

    const createdConsultantRows: MockEarningRow[] = [];

    const tx = {
      consultantEarnings: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(
          async ({ data }: { data: Omit<MockEarningRow, "id"> }) => {
            const row = {
              id: `ce-${createdConsultantRows.length + 1}`,
              ...data,
            };
            createdConsultantRows.push(row);
            return row;
          },
        ),
      },
      organizationEarnings: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(),
      },
      collaborator: {
        findMany: jest.fn(async () => [
          {
            id: "collab-b2b",
            consultantProfileId: "cp-collab-b2b",
            status: "ACCEPTED",
            role: "CO_INSTRUCTOR",
            revenueShareBps: 3000,
            consultantProfile: {
              userId: "u-collab-b2b",
              user: { name: "B2B Collab" },
            },
          },
        ]),
      },
      classPlan: {
        findUnique: jest.fn(async () => ({
          consultantProfileId: "cp-host-b2b",
          organizationId: null,
        })),
      },
      membership: { findFirst: jest.fn(async () => null) },
      rateCard: { findFirst: jest.fn(async () => null) },
      contract: { findFirst: jest.fn(async () => null) },
      paymentLeg: {
        findMany: jest.fn(async () => [
          { source: "WALLET", amountPaise: 50_000 },
        ]),
      },
      billingAccount: {
        findUnique: jest.fn(async () => ({
          ownerOrgId: "org-sponsor",
          fundingSource: "WALLET",
        })),
      },
      organization: {
        findUnique: jest.fn(async () => ({ status: "ACTIVE" })),
      },
    };

    await createEarningsFromPayment({
      payment: {
        id: "pay-b2b",
        userId: "u-learner",
        organizationId: "org-sponsor",
        billingAccountId: "ba-sponsor",
        amount: 50_000,
        originalAmount: 50_000,
        taxAmount: 0,
        currency: "INR",
        createdAt: new Date("2026-10-09T10:00:00Z"),
        appointmentId: "appt-b2b",
        appointment: {
          consultantProfile: { id: "cp-host-b2b" },
          organizationId: null,
          class: { classPlanId: "cp-plan-b2b" },
        },
      } as never,
      appointmentType: "CLASS",
      tx: tx as never,
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

    const journalArg = mockPostLedgerTxn.mock.calls[0][1] as {
      postings: Posting[];
    };
    const { debits } = assertJournalBalanced(journalArg.postings);
    expect(debits).toBe(50_000);
  });
});
