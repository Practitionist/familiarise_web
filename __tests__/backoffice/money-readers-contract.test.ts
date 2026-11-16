/**
 * @jest-environment node
 */

/**
 * Each money reader's real output parses with the schema its screen uses, so
 * a drift between route and screen fails here. Also pinned: the disputes email
 * gate, the batched approver and target reads, and the TDS consultants paging.
 */

import { NextRequest } from "next/server";

import {
  disputeListPageSchema,
  earningListPageSchema,
  orgPayoutListPageSchema,
  proposalPageSchema,
} from "@/lib/backoffice/money-list-schemas";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/feature-flags", () => ({ ENABLE_TDS_ADMIN_VIEW: true }));
const mockViewer = { id: "staff-1", role: "STAFF" };
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({ session: { user: mockViewer } }),
}));

const mockAt = new Date("2026-11-01T04:30:00Z");
const mockAppointment = {
  id: "appt-1",
  appointmentType: "CONSULTATION",
  consultation: { consultationPlan: { title: "Career coaching" } },
  subscription: null,
  webinar: null,
  class: null,
  trial: null,
};
const mockBuyer = {
  id: "user-1",
  name: "Priya Anderson",
  email: "priya@example.test",
};

const mockCalls: Record<string, unknown[]> = {};
function mockSpy(name: string, rows: () => unknown) {
  return async (args: unknown) => {
    mockCalls[name] = [...(mockCalls[name] ?? []), args];
    return rows();
  };
}

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    dispute: {
      count: async () => 1,
      findMany: mockSpy("dispute", () => [
        {
          id: "d1",
          disputeId: "disp_1",
          amountPaise: 150_000,
          currency: "INR",
          status: "WON",
          reason: "fraudulent",
          paymentGateway: "RAZORPAY",
          dueBy: null,
          createdAt: mockAt,
          payment: {
            id: "pay-1",
            paymentIntent: "order_1",
            user: mockBuyer,
            appointment: mockAppointment,
          },
        },
      ]),
    },
    organizationPayout: {
      count: async () => 41,
      findMany: mockSpy("organizationPayout", () => [
        {
          id: "op-1",
          organizationId: "org-1",
          organization: { name: "Wipro", slug: "wipro" },
          amountPaise: 6_000_000,
          netPayoutPaise: 5_880_000,
          tdsAmountPaise: 120_000,
          currency: "INR",
          status: "PENDING",
          periodStart: mockAt,
          periodEnd: mockAt,
          createdAt: mockAt,
          createdBy: "user-9",
          orgApprovedBy: "user-8",
          approvedBy: null,
          approvedAt: null,
          platformApprovalRequiredAt: mockAt,
          platformHeldAt: null,
          failureReason: null,
        },
      ]),
    },
    user: {
      findMany: mockSpy("user", () => [
        { id: "user-8", name: "Olivia Brown", email: "olivia@example.test" },
      ]),
    },
    consultantEarnings: {
      count: async () => 1,
      findMany: mockSpy("consultantEarnings", () => [
        {
          id: "e1",
          paymentId: "pay-1",
          consultantProfileId: "cp-1",
          consultantSharePaise: 120_000,
          status: "HELD",
          holdUntil: mockAt,
          consultantProfile: {
            id: "cp-1",
            userId: "user-2",
            user: { name: "Aarav Anderson", email: "aarav@example.test" },
          },
          payment: {
            id: "pay-1",
            amount: 150_000,
            currency: "INR",
            user: mockBuyer,
            appointment: mockAppointment,
          },
          payout: null,
          // A column no caller reads; the body must not carry it.
          refundedShareAmount: 0,
        },
      ]),
    },
    consultantPayout: {
      count: async () => 0,
      findMany: mockSpy("consultantPayout", () => []),
    },
    opsActionProposal: {
      count: async () => 1,
      findMany: mockSpy("opsActionProposal", () => [
        {
          id: "prop-1",
          action: "refund.issue",
          surface: "refunds.manage",
          targetKind: "Payment",
          targetId: "pay-1",
          amountPaise: 3_000_000,
          reason: "Host never joined",
          status: "PROPOSED",
          decidedAt: null,
          decisionReason: null,
          expiresAt: new Date("2999-01-01T00:00:00Z"),
          createdAt: mockAt,
          proposedBy: { id: "admin-1", name: "Olivia Brown" },
          decidedBy: null,
        },
      ]),
    },
    payment: {
      findMany: mockSpy("payment", () => [
        { id: "pay-1", user: mockBuyer, appointment: mockAppointment },
      ]),
    },
    tDSRecord: {
      groupBy: async (args: { where: { reportedInForm26Q?: boolean } }) => {
        const group = (id: string, tds: number) => ({
          consultantProfileId: id,
          organizationId: null,
          _sum: { tdsDeducted: tds },
          _max: { cumulativeAmountCredited: tds * 100 },
          _count: 2,
        });
        // cp-b has an unfiled record; cp-a and cp-c are filed.
        return args.where.reportedInForm26Q === false
          ? [{ ...group("cp-b", 0), _count: 1 }]
          : [group("cp-a", 3_000), group("cp-b", 2_000), group("cp-c", 1_000)];
      },
    },
    consultantProfile: {
      findMany: mockSpy("consultantProfile", () => [
        {
          id: "cp-c",
          userId: "user-c",
          user: { id: "user-c", name: "Chitra", email: "chitra@example.test" },
          taxInfo: { panLast4: "1234", panVerified: true },
        },
      ]),
    },
    organization: { findMany: mockSpy("organization", () => []) },
  },
}));

import { GET as disputesGet } from "../../app/api/admin/disputes/route";
import { GET as orgPayoutsGet } from "../../app/api/admin/org-payouts/route";
import { GET as earningsGet } from "../../app/api/admin/earnings/route";
import { listProposals } from "../../lib/backoffice/ops-proposals";
import { resolveTargets, targetKey } from "../../lib/backoffice/target-refs";
import { GET as tdsGet } from "../../app/api/admin/tds/route";
import { getOperatorPayouts } from "../../lib/api/operators/payouts";

jest.mock("../../lib/payments/payouts", () => ({
  getPayoutStats: async () => ({}),
}));

const get = async (
  route: (r: NextRequest) => Promise<Response>,
  path: string,
) => (await route(new NextRequest(`http://test${path}`))).json();

beforeEach(() => {
  for (const key of Object.keys(mockCalls)) delete mockCalls[key];
  mockViewer.role = "STAFF";
});

describe("disputes list", () => {
  it("names the buyer and booking and withholds the email from staff", async () => {
    const page = disputeListPageSchema.parse(
      await get(disputesGet, "/api/admin/disputes?status=WON"),
    );
    expect(page.disputes[0].payment).toMatchObject({
      buyer: { name: "Priya Anderson" },
      booking: { title: "Career coaching", type: "CONSULTATION" },
    });
    const select = (
      mockCalls.dispute[0] as {
        select: {
          payment: { select: { user: { select: { email: boolean } } } };
        };
      }
    ).select;
    expect(select.payment.select.user.select.email).toBe(false);
  });

  it("sends the email to a viewer holding disputes.manage", async () => {
    mockViewer.role = "ADMIN";
    await get(disputesGet, "/api/admin/disputes?status=WON");
    const select = (
      mockCalls.dispute[0] as {
        select: {
          payment: { select: { user: { select: { email: boolean } } } };
        };
      }
    ).select;
    expect(select.payment.select.user.select.email).toBe(true);
  });
});

it("org payouts name the creator and approvers in one batched read", async () => {
  const page = orgPayoutListPageSchema.parse(
    await get(orgPayoutsGet, "/api/admin/org-payouts?offset=20"),
  );
  expect(mockCalls.user).toHaveLength(1);
  expect(mockCalls.user[0]).toMatchObject({
    where: { id: { in: ["user-9", "user-8"] } },
  });
  expect(page.payouts[0].orgApprovedByUser?.name).toBe("Olivia Brown");
  // A creator no longer on file keeps their id.
  expect(page.payouts[0].createdByUser).toEqual({
    id: "user-9",
    name: null,
    email: null,
  });
  expect(page.pagination).toMatchObject({ total: 41, limit: 20, offset: 20 });
});

describe("D10: STAFF see the emails the money rows name, as on the payment detail", () => {
  it("org payouts send STAFF the creator's and approvers' emails", async () => {
    expect(mockViewer.role).toBe("STAFF");
    const page = orgPayoutListPageSchema.parse(
      await get(orgPayoutsGet, "/api/admin/org-payouts"),
    );
    expect(mockCalls.user[0]).toMatchObject({
      select: { id: true, name: true, email: true },
    });
    expect(page.payouts[0].orgApprovedByUser?.email).toBe(
      "olivia@example.test",
    );
  });

  it("earnings send STAFF the buyer's email", async () => {
    const page = earningListPageSchema.parse(
      await get(earningsGet, "/api/admin/earnings"),
    );
    expect(page.earnings[0].payment?.buyer?.email).toBe("priya@example.test");
  });

  it("a payment target names the buyer with their email", async () => {
    const refs = await resolveTargets([{ kind: "Payment", id: "pay-1" }]);
    expect(refs.get(targetKey("Payment", "pay-1"))?.person?.email).toBe(
      "priya@example.test",
    );
  });
});

it("earnings name the buyer and booking and clamp the page", async () => {
  const page = earningListPageSchema.parse(
    await get(earningsGet, "/api/admin/earnings?limit=500&offset=-4"),
  );
  expect(page.earnings[0].payment).toMatchObject({
    buyer: { name: "Priya Anderson" },
    booking: { title: "Career coaching" },
  });
  expect(mockCalls.consultantEarnings[0]).toMatchObject({
    take: 100,
    skip: 0,
    relationLoadStrategy: "join",
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  // Field by field: a column the screen does not read stays on the server.
  expect(Object.keys(page.earnings[0])).not.toContain("refundedShareAmount");
  const raw = await get(earningsGet, "/api/admin/earnings");
  expect(Object.keys(raw.earnings[0]).sort()).toEqual(
    [
      "consultantProfile",
      "consultantProfileId",
      "consultantSharePaise",
      "holdUntil",
      "id",
      "payment",
      "paymentId",
      "status",
    ].sort(),
  );
});

it("ties on the pay-by date and creation break by id, so payout pages never overlap", async () => {
  await getOperatorPayouts({ status: "PENDING", limit: 20, offset: 20 });
  expect(
    (mockCalls.consultantPayout[0] as { orderBy: unknown[] }).orderBy,
  ).toEqual([
    { mustPayByDate: { sort: "asc", nulls: "last" } },
    { createdAt: "desc" },
    { id: "asc" },
  ]);
});

it("disputes order each page with an id tie-break", async () => {
  await get(disputesGet, "/api/admin/disputes?status=WON");
  expect((mockCalls.dispute[0] as { orderBy: unknown[] }).orderBy).toEqual([
    { createdAt: "desc" },
    { id: "desc" },
  ]);
});

it("proposals page, and resolve their target in one read per kind", async () => {
  const page = proposalPageSchema.parse(
    await listProposals("PROPOSED", new Date("2026-11-17T00:00:00Z"), 2),
  );
  expect(mockCalls.opsActionProposal[0]).toMatchObject({ skip: 20, take: 20 });
  expect(mockCalls.payment).toHaveLength(1);
  expect(page.proposals[0].target).toMatchObject({
    person: { name: "Priya Anderson" },
    booking: { title: "Career coaching" },
  });
});

describe("TDS consultants view", () => {
  it("pages by the largest withholding after the filing filter", async () => {
    mockViewer.role = "ADMIN";
    const body = await get(
      tdsGet,
      "/api/admin/tds?fy=2026-27&view=consultants&filing=FILED&page=2&pageSize=1",
    );
    expect(body).toMatchObject({
      total: 2,
      deducteeCount: 3,
      page: 2,
      pageSize: 1,
    });
    expect(
      body.consultants.map((c: { deducteeKey: string }) => c.deducteeKey),
    ).toEqual(["consultant:cp-c"]);
    // Names are read for the page only.
    expect(mockCalls.consultantProfile[0]).toMatchObject({
      where: { id: { in: ["cp-c"] } },
    });
  });

  it("clamps the page size at 100 and a page past the cap to the cap", async () => {
    mockViewer.role = "ADMIN";
    const body = await get(
      tdsGet,
      "/api/admin/tds?fy=2026-27&view=consultants&pageSize=5000&page=x",
    );
    expect(body).toMatchObject({ page: 1, pageSize: 100, total: 3 });
    const far = await get(
      tdsGet,
      "/api/admin/tds?fy=2026-27&view=consultants&page=20000",
    );
    expect(far).toMatchObject({ page: 10_000 });
  });

  it("answers 400 for a search longer than 200 characters", async () => {
    mockViewer.role = "ADMIN";
    const res = await tdsGet(
      new NextRequest(
        `http://test/api/admin/tds?fy=2026-27&view=consultants&q=${"a".repeat(201)}`,
      ),
    );
    expect(res.status).toBe(400);
  });
});

it("a malformed body fails each list schema", () => {
  expect(
    orgPayoutListPageSchema.safeParse({ payouts: [{ id: 1 }], pagination: {} })
      .success,
  ).toBe(false);
  expect(earningListPageSchema.safeParse({ earnings: null }).success).toBe(
    false,
  );
  expect(
    proposalPageSchema.safeParse({
      proposals: [],
      total: -1,
      page: 1,
      pageSize: 20,
    }).success,
  ).toBe(false);
  expect(
    disputeListPageSchema.safeParse({ disputes: [{ status: "MAYBE" }] })
      .success,
  ).toBe(false);
});
