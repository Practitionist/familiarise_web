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
  requireFreshSession: () => null,
}));

let mockViewer = "admin_a";
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: mockViewer, role: "ADMIN" } },
  }),
}));

type Row = Record<string, unknown> & { id: string; expiresAt: Date };
const mockRows = new Map<string, Row>();
const mockState = { admins: 2, seq: 0 };

function mockMatches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === "NOT") {
      const not = want as Record<string, unknown>;
      return Object.entries(not).every(([k, v]) => row[k] !== v);
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
    opsActionLog: { create: async () => ({ id: "log" }) },
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

import { NextRequest } from "next/server";
import { POST as refund } from "../../app/api/admin/refunds/issue/route";
import { POST as approve } from "../../app/api/admin/ops-proposals/[id]/approve/route";
import { POST as reject } from "../../app/api/admin/ops-proposals/[id]/reject/route";

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
