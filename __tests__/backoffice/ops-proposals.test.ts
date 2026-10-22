/**
 * @jest-environment node
 */

/**
 * F10 — a money door above ₹25,000 runs directly with one active admin, and with
 * two is held as a proposal that only a different admin can approve, exactly once.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));
jest.mock("../../lib/auth/step-up", () => ({
  requireFreshSession: () =>
    mockState.stale
      ? jest
          .requireActual<typeof import("next/server")>("next/server")
          .NextResponse.json(
            { error: "Confirm it is you", code: "REAUTH_REQUIRED" },
            { status: 403 },
          )
      : null,
}));

let mockViewer = "admin_a";
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: { user: { id: mockViewer, role: mockState.role } },
  }),
  requireBackofficeSurface: async (surface: BackofficeSurface) =>
    jest
      .requireActual<typeof import("../../lib/auth/backoffice-permissions")>(
        "../../lib/auth/backoffice-permissions",
      )
      .hasBackofficePermission(mockState.role, surface)
      ? { session: { user: { id: mockViewer, role: mockState.role } } }
      : {
          error: jest
            .requireActual<typeof import("next/server")>("next/server")
            .NextResponse.json({ code: "FORBIDDEN" }, { status: 403 }),
        },
}));
jest.mock("../../lib/backoffice/maintenance-gate", () => ({
  assertMoneyDoorsOpen: jest.fn(),
}));
jest.mock("../../lib/support/case-doors", () => ({}));

jest.mock("../../lib/backoffice/money-limit", () => ({
  assertMoneyOpsBudget: jest.fn(),
}));

type Row = Record<string, unknown> & { id: string; expiresAt: Date };
const mockRows = new Map<string, Row>();
const mockState: {
  admins: number;
  seq: number;
  role: "ADMIN" | "STAFF";
  stale: boolean;
  caseExists: boolean;
  recommendationCaseId: string;
  recommendationAmount: number;
  recommendationApproved: boolean | null;
  recommendationRefundId: string | null;
  committedPaise: number;
  originalReviewerId: string | null;
} = {
  admins: 2,
  seq: 0,
  role: "ADMIN",
  stale: false,
  caseExists: true,
  recommendationCaseId: "case_1",
  recommendationAmount: 5_000_000,
  recommendationApproved: null,
  recommendationRefundId: null,
  committedPaise: 0,
  originalReviewerId: null,
};
const mockRefundReviews = jest.fn();
const mockScopeReads = jest.fn();
const mockAuditRows = jest.fn();

jest.mock("../../lib/support/case-actions", () => {
  const { CaseRefundReviewSchema } = jest.requireActual<
    typeof import("../../schemas/support-refund-review")
  >("../../schemas/support-refund-review");
  class CaseActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status = 409,
    ) {
      super(message);
    }
  }
  const { OpsRefusal } = jest.requireActual<
    typeof import("../../lib/backoffice/ops-refusal-error")
  >("../../lib/backoffice/ops-refusal-error");
  return {
    CaseActionError,
    CaseActionRequestSchema: CaseRefundReviewSchema,
    readCaseResolution: jest.fn(),
    // Wiring double: the real pricing and staff limits are pinned in
    // __tests__/support/case-money-hardening.test.ts.
    priceCaseRefundReview: async (
      _tx: unknown,
      caseId: string,
      actor: { role: string },
      body: { approve: boolean },
    ) => {
      if (caseId !== mockState.recommendationCaseId)
        throw new CaseActionError(
          "NOT_FOUND",
          "Recommendation not found.",
          404,
        );
      if (!body.approve || mockState.recommendationRefundId) return 0;
      if (actor.role === "STAFF" && mockState.recommendationAmount > 500_000)
        throw new OpsRefusal("ADMIN_REQUIRED", "Needs an admin.", 403);
      return mockState.recommendationAmount + mockState.committedPaise;
    },
    assertIndependentReviewer: async (
      _tx: unknown,
      _supportCase: unknown,
      reviewerId: string,
    ) => {
      if (mockState.originalReviewerId === reviewerId)
        throw new CaseActionError(
          "INDEPENDENT_REVIEW_REQUIRED",
          "A different eligible operator must review this appeal.",
          403,
        );
    },
    performCaseAction: async (...args: unknown[]) => {
      mockRefundReviews(...args);
      return { ok: true };
    },
  };
});

function mockMatches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === "OR") {
      return (want as Record<string, unknown>[]).some((w) =>
        mockMatches(row, w),
      );
    }
    if (want && typeof want === "object" && "not" in want) {
      // SQL: NULL <> x is not true, so `not` never matches a NULL column.
      return (row[key] ?? null) !== null && row[key] !== want.not;
    }
    if (key === "expiresAt") {
      const { gt, lte } = want as { gt?: Date; lte?: Date };
      if (gt) return row.expiresAt > gt;
      if (lte) return row.expiresAt <= lte;
    }
    return row[key] === want;
  });
}

jest.mock("../../lib/prisma", () => {
  const db = {
    user: { count: async () => mockState.admins },
    supportCase: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        mockScopeReads(where);
        return mockState.caseExists && where.id === "case_1"
          ? {
              id: "case_1",
              ownershipScope: "PERSONAL",
              submitterUserId: "customer",
              requesterUserId: "customer",
              organizationId: null,
              appealOfDecisionId: null,
              appealOfModerationActionId: null,
            }
          : null;
      },
    },
    supportFinancialRecommendation: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; caseId: string };
      }) =>
        where.id === "rec_1" && where.caseId === mockState.recommendationCaseId
          ? {
              id: "rec_1",
              amountPaise: mockState.recommendationAmount,
              approved: mockState.recommendationApproved,
              decidedAt:
                mockState.recommendationApproved === null ? null : new Date(),
              refund: mockState.recommendationRefundId
                ? { id: mockState.recommendationRefundId }
                : null,
            }
          : null,
    },
    opsActionLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        mockAuditRows(data);
        return { id: "log" };
      },
    },
    opsActionProposal: {
      create: async ({ data }: { data: Row }) => {
        const open = [...mockRows.values()].some(
          (r) =>
            r.status === "PROPOSED" &&
            r.action === data.action &&
            r.targetId === data.targetId,
        );
        if (open) throw Object.assign(new Error("dup"), { code: "P2002" });
        const row: Row = {
          ...data,
          id: `prop_${++mockState.seq}`,
          status: "PROPOSED",
        };
        mockRows.set(row.id, row);
        return { id: row.id, expiresAt: row.expiresAt };
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        mockRows.get(where.id) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const hit = [...mockRows.values()].filter((r) => mockMatches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { __esModule: true, default: db };
});

const mockRan = jest.fn();
jest.mock("../../app/api/admin/refunds/issue/route", () => {
  const { withOpsAction } = jest.requireActual<
    typeof import("../../lib/backoffice/ops-action-log")
  >("../../lib/backoffice/ops-action-log");
  const { z } = jest.requireActual<typeof import("zod")>("zod");
  return {
    POST: withOpsAction(
      "refunds.manage",
      "refund.issue",
      { paymentId: z.string(), amountPaise: z.number() },
      {
        mode: "tx",
        run: async (_tx, ctx) => {
          mockRan(ctx.actor.userId);
          return {
            target: { kind: "Payment", id: ctx.body.paymentId },
            response: { refunded: ctx.body.amountPaise },
          };
        },
      },
      {
        stepUp: true,
        secondApprover: {
          route: "/api/admin/refunds/issue",
          target: ({ body }) => ({ kind: "Payment", id: body.paymentId }),
          amountPaise: (body) => body.amountPaise,
        },
      },
    ),
  };
});
function mockOther(n: number) {
  return { POST: { proposalRoute: `/other/${n}` } };
}
jest.mock("../../app/api/admin/refunds/route", () => mockOther(1));
jest.mock(
  "../../app/api/admin/organizations/[orgId]/invoices/[invoiceId]/void/route",
  () => mockOther(2),
);
jest.mock(
  "../../app/api/admin/organizations/[orgId]/invoices/[invoiceId]/issue/route",
  () => mockOther(3),
);
jest.mock(
  "../../app/api/admin/organizations/[orgId]/invoices/[invoiceId]/payments/route",
  () => mockOther(4),
);
jest.mock(
  "../../app/api/admin/organizations/[orgId]/overages/[overageEventId]/settle-to-org/route",
  () => mockOther(5),
);
jest.mock(
  "../../app/api/admin/organizations/[orgId]/billing-account/route",
  () => ({ PATCH: { proposalRoute: "/other/6" } }),
);
jest.mock("../../app/api/admin/org-payouts/[id]/approve/route", () =>
  mockOther(7),
);
jest.mock(
  "../../app/api/admin/billing-accounts/[billingAccountId]/wallet-adjustment/route",
  () => mockOther(8),
);
jest.mock(
  "../../app/api/admin/billing-accounts/[billingAccountId]/refund-remaining/route",
  () => mockOther(9),
);

import { NextRequest } from "next/server";
import type { BackofficeSurface } from "../../lib/auth/backoffice-permissions";
import { POST as refund } from "../../app/api/admin/refunds/issue/route";
import { POST as approve } from "../../app/api/admin/ops-proposals/[id]/approve/route";
import { POST as reject } from "../../app/api/admin/ops-proposals/[id]/reject/route";
import { POST as supportRefund } from "../../app/api/support/cases/[caseId]/actions/route";
import { assertMoneyOpsBudget } from "../../lib/backoffice/money-limit";
import { OpsRefusal } from "../../lib/backoffice/ops-refusal-error";
import { CaseActionError } from "../../lib/support/case-actions";

const call = (
  door: typeof approve,
  body: object,
  params: Record<string, string> = {},
) =>
  door(
    new NextRequest("https://x.test/api", {
      method: "POST",
      body: JSON.stringify({ reason: "customer was double charged", ...body }),
    }),
    { params: Promise.resolve(params) },
  );

const propose = async (amountPaise: number, paymentId = "pay_1") => {
  mockViewer = "admin_a";
  const res = await call(refund, { paymentId, amountPaise });
  return { status: res.status, json: await res.json() };
};

beforeEach(() => {
  mockRows.clear();
  mockRan.mockClear();
  mockState.admins = 2;
  mockState.role = "ADMIN";
  mockState.stale = false;
  mockState.caseExists = true;
  mockState.recommendationCaseId = "case_1";
  mockState.recommendationAmount = 5_000_000;
  mockState.recommendationApproved = null;
  mockState.recommendationRefundId = null;
  mockState.committedPaise = 0;
  mockState.originalReviewerId = null;
  mockViewer = "admin_a";
  mockRefundReviews.mockReset();
  mockScopeReads.mockClear();
  mockAuditRows.mockClear();
  jest.mocked(assertMoneyOpsBudget).mockReset();
  jest.mocked(assertMoneyOpsBudget).mockResolvedValue(undefined);
});

it("runs directly below the threshold, or above it with one admin", async () => {
  expect((await propose(2_500_000)).status).toBe(200);
  mockState.admins = 1;
  expect((await propose(9_000_000)).status).toBe(200);
  expect(mockRan).toHaveBeenCalledTimes(2);
  expect(mockRows.size).toBe(0);
});

it("holds an amount above ₹25,000 with two admins, then runs once as the approver", async () => {
  const proposed = await propose(2_500_001);
  expect(proposed.status).toBe(202);
  expect(proposed.json).toMatchObject({ status: "PROPOSED" });
  expect(mockRan).not.toHaveBeenCalled();
  const id = proposed.json.proposalId as string;

  const self = await call(approve, {}, { id });
  expect(self.status).toBe(403);
  expect((await self.json()).code).toBe("SAME_ADMIN");

  mockViewer = "admin_b";
  const ok = await call(approve, {}, { id });
  expect(ok.status).toBe(200);
  expect(mockRan).toHaveBeenCalledWith("admin_b");
  expect(mockRows.get(id)).toMatchObject({
    status: "EXECUTED",
    decidedById: "admin_b",
  });

  const again = await call(approve, {}, { id });
  expect(again.status).toBe(409);
  expect(mockRan).toHaveBeenCalledTimes(1);
});

it("rejects without running, and refuses an expired proposal", async () => {
  const first = (await propose(5_000_000)).json.proposalId as string;
  mockViewer = "admin_b";
  expect((await call(reject, {}, { id: first })).status).toBe(200);
  expect(mockRows.get(first)?.status).toBe("REJECTED");

  const second = (await propose(5_000_000, "pay_2")).json.proposalId as string;
  mockRows.get(second)!.expiresAt = new Date(Date.now() - 1);
  mockViewer = "admin_b";
  const expired = await call(approve, {}, { id: second });
  expect(expired.status).toBe(409);
  expect((await expired.json()).code).toBe("PROPOSAL_EXPIRED");
  expect(mockRan).not.toHaveBeenCalled();
});

it("leaves a failed replay APPROVED with its code, and frees the target", async () => {
  const id = (await propose(5_000_000)).json.proposalId as string;
  mockRan.mockImplementationOnce(() => {
    throw new Error("gateway down");
  });
  mockViewer = "admin_b";
  expect((await call(approve, {}, { id })).status).toBe(500);
  expect(mockRows.get(id)).toMatchObject({
    status: "APPROVED",
    decisionReason: expect.stringContaining("execution failed: FAILED"),
  });
  expect((await propose(5_000_000)).status).toBe(202);
});

const reviewSupportRefund = (body: Record<string, unknown> = {}) =>
  supportRefund(
    new NextRequest("https://x.test/api/support/cases/case_1/actions", {
      method: "POST",
      body: JSON.stringify({
        action: "REVIEW_REFUND",
        recommendationId: "rec_1",
        approve: true,
        reason: "The session was not delivered",
        clientActionId: "review_1",
        expectedUpdatedAt: "2026-10-20T12:00:00.000Z",
        expectedRefundablePaise: 5_000_000,
        ...body,
      }),
    }),
    { params: Promise.resolve({ caseId: "case_1" }) },
  );

describe("case refund review shares the admin money policy", () => {
  it("holds a case recommendation and replays its original request as a different admin", async () => {
    const proposed = await reviewSupportRefund();
    expect(proposed.status).toBe(202);
    const { proposalId } = await proposed.json();
    expect(mockRefundReviews).not.toHaveBeenCalled();
    expect(mockRows.get(proposalId)).toMatchObject({
      surface: "/api/support/cases/[caseId]/actions",
      action: "support.refund.review",
      targetKind: "SupportFinancialRecommendation",
      targetId: "rec_1",
      routeParams: { caseId: "case_1" },
    });

    expect((await call(approve, {}, { id: proposalId })).status).toBe(403);
    mockViewer = "admin_b";
    expect((await call(approve, {}, { id: proposalId })).status).toBe(200);
    expect(mockRefundReviews).toHaveBeenCalledWith(
      "case_1",
      { userId: "admin_b", role: "ADMIN" },
      expect.objectContaining({
        action: "REVIEW_REFUND",
        recommendationId: "rec_1",
        clientActionId: "review_1",
        expectedUpdatedAt: "2026-10-20T12:00:00.000Z",
        expectedRefundablePaise: 5_000_000,
      }),
    );
    expect(assertMoneyOpsBudget).toHaveBeenCalledWith("admin_b");
    expect(mockRows.get(proposalId)?.status).toBe("EXECUTED");
    expect(mockAuditRows).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "support.refund.review",
        targetId: "rec_1",
        after: expect.objectContaining({ caseId: "case_1", proposalId }),
      }),
    );
    expect((await call(approve, {}, { id: proposalId })).status).toBe(409);
    expect(mockRefundReviews).toHaveBeenCalledTimes(1);
  });

  it("executes at the threshold or with only one admin, without opening a proposal", async () => {
    mockState.recommendationAmount = 2_500_000;
    expect((await reviewSupportRefund()).status).toBe(200);
    mockState.recommendationAmount = 5_000_000;
    mockState.admins = 1;
    expect((await reviewSupportRefund()).status).toBe(200);
    expect(mockRows.size).toBe(0);
    expect(mockRefundReviews).toHaveBeenCalledTimes(2);
    expect(assertMoneyOpsBudget).toHaveBeenCalledTimes(2);
  });

  it("rejects a high-value recommendation directly and audits the review", async () => {
    const response = await reviewSupportRefund({ approve: false });
    expect(response.status).toBe(200);
    expect(mockRows.size).toBe(0);
    expect(mockRefundReviews).toHaveBeenCalledWith(
      "case_1",
      { userId: "admin_a", role: "ADMIN" },
      expect.objectContaining({ approve: false }),
    );
    expect(mockAuditRows).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "support.refund.review",
        after: expect.objectContaining({ approved: false }),
      }),
    );
  });

  it("returns an existing keyed refund without requesting a second approval", async () => {
    mockState.recommendationApproved = true;
    mockState.recommendationRefundId = "refund_existing";
    expect((await reviewSupportRefund()).status).toBe(200);
    expect(mockRows.size).toBe(0);
    expect(mockRefundReviews).toHaveBeenCalledTimes(1);
  });

  it.each(["missing-case", "other-case-recommendation", "original-reviewer"])(
    "authorizes %s before opening any proposal",
    async (scenario) => {
      if (scenario === "missing-case") mockState.caseExists = false;
      if (scenario === "other-case-recommendation")
        mockState.recommendationCaseId = "case_other";
      if (scenario === "original-reviewer")
        mockState.originalReviewerId = "admin_a";
      const response = await reviewSupportRefund();
      expect(response.status).toBe(
        scenario === "original-reviewer" ? 403 : 404,
      );
      expect(mockRows.size).toBe(0);
      expect(mockRefundReviews).not.toHaveBeenCalled();
    },
  );

  it("prices the remedy with those already committed on its payment, so a split still needs a second admin", async () => {
    mockState.recommendationAmount = 1_000_000;
    mockState.committedPaise = 2_000_000;
    expect((await reviewSupportRefund()).status).toBe(202);
    expect(mockRefundReviews).not.toHaveBeenCalled();
  });

  it("lets staff execute within the limit, and refuses above it without opening a proposal", async () => {
    mockState.role = "STAFF";
    mockViewer = "staff_a";
    mockState.recommendationAmount = 400_000;
    expect((await reviewSupportRefund()).status).toBe(200);
    mockState.recommendationAmount = 5_000_000;
    const refused = await reviewSupportRefund();
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("ADMIN_REQUIRED");
    expect(mockRows.size).toBe(0);
    expect(mockRefundReviews).toHaveBeenCalledTimes(1);
  });

  it("refuses a staff approval of a proposal", async () => {
    const { proposalId } = await (await reviewSupportRefund()).json();
    mockState.role = "STAFF";
    mockViewer = "staff_a";
    expect((await call(approve, {}, { id: proposalId })).status).toBe(403);
    expect(mockRefundReviews).not.toHaveBeenCalled();
  });

  it("refuses an approval without the previewed refundable balance", async () => {
    const response = await reviewSupportRefund({
      expectedRefundablePaise: undefined,
    });
    expect(response.status).toBe(400);
    expect(mockRefundReviews).not.toHaveBeenCalled();
  });

  it.each(["stale-session", "short-reason"])(
    "refuses %s before case reads or execution",
    async (scenario) => {
      if (scenario === "stale-session") mockState.stale = true;
      const response = await reviewSupportRefund(
        scenario === "short-reason" ? { reason: "ok" } : {},
      );
      expect(response.status).toBe(scenario === "short-reason" ? 400 : 403);
      expect(mockScopeReads).not.toHaveBeenCalled();
      expect(mockRows.size).toBe(0);
      expect(mockRefundReviews).not.toHaveBeenCalled();
    },
  );

  it("applies the shared execution budget before a refund can run", async () => {
    mockState.recommendationAmount = 1000;
    jest
      .mocked(assertMoneyOpsBudget)
      .mockRejectedValueOnce(
        new OpsRefusal("RATE_LIMITED", "Wait and try again.", 429),
      );
    const response = await reviewSupportRefund();
    expect(response.status).toBe(429);
    expect(mockRefundReviews).not.toHaveBeenCalled();
  });

  it("preserves a changed-preview refusal when a second admin executes", async () => {
    const proposed = await reviewSupportRefund();
    const { proposalId } = await proposed.json();
    mockViewer = "admin_b";
    mockRefundReviews.mockImplementationOnce(() => {
      throw new CaseActionError(
        "PREVIEW_CHANGED",
        "Refresh the refund preview.",
      );
    });
    const response = await call(approve, {}, { id: proposalId });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PREVIEW_CHANGED");
    expect(mockRows.get(proposalId)).toMatchObject({
      status: "APPROVED",
      decisionReason: expect.stringContaining(
        "execution failed: PREVIEW_CHANGED",
      ),
    });
  });
});
