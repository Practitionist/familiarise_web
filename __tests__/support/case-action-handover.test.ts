/**
 * @jest-environment node
 */

/**
 * The case hand-off action.
 *
 * Every case action opens with ONE compare-and-set on the row's `updatedAt`.
 * That CAS bumps the column, so a SECOND guard on the same `updatedAt` can
 * never match afterwards — the hand-off's own write must not carry one, or
 * the action fails with CONFLICT on every call and a case can never be
 * reassigned or handed back to the queue.
 *
 * The mock below reproduces the database's CAS semantics rather than
 * returning a blanket `{ count: 1 }`: a write whose `where.updatedAt` no
 * longer matches the row matches no rows.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  metrics: { count: jest.fn() },
  logger: { warn: jest.fn() },
}));

jest.mock("../../lib/support/case-access", () => ({
  __esModule: true,
  canCorrespondOnCase: jest.fn(async () => true),
}));

jest.mock("../../lib/novu/stage-bell", () => ({
  __esModule: true,
  stageBell: jest.fn(async () => null),
}));

jest.mock("../../lib/support/case-service", () => ({
  __esModule: true,
  executePatchLifecycleTx: jest.fn(),
}));

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: jest.fn(),
}));

jest.mock("../../lib/backoffice/refund-doors", () => ({
  __esModule: true,
  refundInFlightOr: jest.fn(),
}));

jest.mock("../../lib/novu/resolve-href", () => ({
  __esModule: true,
  supportRequestHref: jest.fn(() => "/dashboard/support"),
}));

const EXPECTED_UPDATED_AT = new Date("2026-10-19T10:00:00.000Z");

/** The row the transaction reads and writes; `updatedAt` moves on each CAS. */
type CaseRow = {
  id: string;
  updatedAt: Date;
  assignedToId: string | null;
  ownershipScope: string;
  submitterUserId: string;
  requesterUserId: string;
  deletedAt: Date | null;
};

let row: CaseRow;

const mockUpdateMany = jest.fn(
  async (args: {
    where: { id: string; updatedAt?: Date };
    data: { updatedAt?: Date };
  }) => {
    if (
      args.where.updatedAt &&
      args.where.updatedAt.getTime() !== row.updatedAt.getTime()
    ) {
      return { count: 0 };
    }
    if (args.data.updatedAt) row = { ...row, updatedAt: args.data.updatedAt };
    return { count: 1 };
  },
);

const mockUpdate = jest.fn(
  async (args: { data: { assignedToId: string | null } }) => {
    row = { ...row, assignedToId: args.data.assignedToId };
    return { ...row };
  },
);

const mockEventCreate = jest.fn(async () => ({ id: "event-1" }));

jest.mock("../../lib/prisma", () => {
  const tx = {
    supportCase: {
      findFirst: jest.fn(async () => ({ ...row })),
      updateMany: (...args: unknown[]) =>
        (mockUpdateMany as (...a: unknown[]) => unknown)(...args),
      update: (...args: unknown[]) =>
        (mockUpdate as (...a: unknown[]) => unknown)(...args),
    },
    supportCaseEvent: {
      create: (...args: unknown[]) => mockEventCreate(...(args as [])),
    },
    user: {
      findUnique: jest.fn(async () => ({ role: "STAFF", name: "Asha" })),
    },
  };
  return {
    __esModule: true,
    default: {
      ...tx,
      $transaction: jest.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
    },
  };
});

import { performCaseAction } from "../../lib/support/case-actions";

const CASE_ID = "case-1";
const ACTOR = { userId: "staff-1", role: "STAFF" as const };

beforeEach(() => {
  jest.clearAllMocks();
  row = {
    id: CASE_ID,
    updatedAt: EXPECTED_UPDATED_AT,
    assignedToId: null,
    ownershipScope: "ORG_OPERATIONS",
    submitterUserId: "user-1",
    requesterUserId: "user-1",
    deletedAt: null,
  };
});

describe("HANDOVER", () => {
  it("reassigns the case instead of failing on its own second CAS", async () => {
    const result = await performCaseAction(CASE_ID, ACTOR, {
      action: "HANDOVER",
      assignedToId: "staff-2",
      reason: "moving to the billing desk",
      clientActionId: "action-1",
      expectedUpdatedAt: EXPECTED_UPDATED_AT.toISOString(),
    });

    expect(result).toEqual({ ok: true, assignedToId: "staff-2" });
    expect(row.assignedToId).toBe("staff-2");
    // The assignment is written once, with no second `updatedAt` guard: the
    // action's own CAS already moved that column.
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: CASE_ID },
      data: { assignedToId: "staff-2" },
    });
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    // The audit trail is unchanged by the fix.
    expect(mockEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ caseId: CASE_ID, kind: "ASSIGNED" }),
    });
  });

  it("hands the case back to the queue", async () => {
    row = { ...row, assignedToId: "staff-2" };
    const result = await performCaseAction(CASE_ID, ACTOR, {
      action: "HANDOVER",
      assignedToId: null,
      reason: "back to the queue",
      clientActionId: "action-2",
      expectedUpdatedAt: EXPECTED_UPDATED_AT.toISOString(),
    });

    expect(result).toEqual({ ok: true, assignedToId: null });
    expect(row.assignedToId).toBeNull();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: CASE_ID },
      data: { assignedToId: null },
    });
    expect(mockEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ caseId: CASE_ID, kind: "UNASSIGNED" }),
    });
  });

  it("still refuses a hand-off onto a case staff already changed", async () => {
    // The action's own CAS is the concurrency guard: a row that moved since
    // the client read it matches no rows and the action is refused.
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      performCaseAction(CASE_ID, ACTOR, {
        action: "HANDOVER",
        assignedToId: "staff-2",
        reason: "moving to the billing desk",
        clientActionId: "action-3",
        expectedUpdatedAt: EXPECTED_UPDATED_AT.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockEventCreate).not.toHaveBeenCalled();
  });
});
