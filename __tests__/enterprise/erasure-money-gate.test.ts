/**
 * @jest-environment node
 */

/**
 * #1598 P4-P0-05 / #1584 P1-ER01 — the erasure process route ran `scrubUser`
 * with no money-in-flight check, and the scrub left the consultee's own free
 * text (profile goals, trial notes, consultation request notes) intact. The
 * route now refuses with ERASURE_BLOCKED_MONEY_IN_FLIGHT while a payout, an
 * unpaid earning, a sole-owner invoice or a live dispute exists, and the scrub
 * nulls the consultee text inside its transaction.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireAdminAuth: jest.fn(async () => ({
    session: { user: { id: "admin_1" } },
  })),
}));
jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(async () => undefined),
}));
jest.mock("../../lib/api/organizations/seat-count", () => ({
  releaseSeatsForTerminatedAssignments: jest.fn(async () => undefined),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/collaborators/standing", () => ({
  removeCollaboratorStanding: jest.fn(async () => []),
}));

const counts = {
  consultantPayout: 0,
  consultantEarnings: 0,
  dispute: 0,
  organizationInvoice: 0,
};
const tx = {
  user: { update: jest.fn(async () => ({})) },
  consultantProfile: { updateMany: jest.fn(async () => ({ count: 0 })) },
  consulteeProfile: { updateMany: jest.fn(async () => ({ count: 1 })) },
  trial: { updateMany: jest.fn(async () => ({ count: 1 })) },
  consultation: { updateMany: jest.fn(async () => ({ count: 1 })) },
  session: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  account: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  erasureRequest: { findFirst: jest.fn(async () => null) },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    erasureRequest: {
      findUnique: jest.fn(async () => ({
        id: "er_1",
        userId: "u1",
        status: "PENDING",
      })),
      update: jest.fn(async () => ({})),
    },
    user: {
      findUnique: jest.fn(async () => ({
        id: "u1",
        erasedAt: null,
        pseudonymousId: null,
      })),
    },
    membership: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
    consultantPayout: { count: jest.fn(async () => counts.consultantPayout) },
    consultantEarnings: {
      count: jest.fn(async () => counts.consultantEarnings),
    },
    dispute: { count: jest.fn(async () => counts.dispute) },
    organizationInvoice: {
      count: jest.fn(async () => counts.organizationInvoice),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  },
}));

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { POST } from "../../app/api/admin/erasure-requests/[id]/process/route";

function post() {
  return POST(
    new NextRequest(
      "http://localhost/api/admin/erasure-requests/er_1/process",
      {
        method: "POST",
      },
    ),
    { params: Promise.resolve({ id: "er_1" }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  counts.consultantPayout = 0;
  counts.consultantEarnings = 0;
  counts.dispute = 0;
  counts.organizationInvoice = 0;
});

describe("erasure money gate and consultee free text (#1598 P4-P0-05)", () => {
  it("refuses a user with a BATCHED earning with the typed code and never scrubs", async () => {
    counts.consultantEarnings = 1;

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("ERASURE_BLOCKED_MONEY_IN_FLIGHT");
    expect(body.counts).toMatchObject({ unsettledEarnings: 1 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    // The request was not moved to IN_PROGRESS either.
    expect(prisma.erasureRequest.update).not.toHaveBeenCalled();
  });

  it("scrubs a clean user and nulls the consultee's goals in the transaction", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(tx.consulteeProfile.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: { goals: null },
    });
    expect(tx.trial.updateMany).toHaveBeenCalledWith({
      where: { consulteeProfile: { userId: "u1" } },
      data: { notes: null },
    });
    expect(tx.consultation.updateMany).toHaveBeenCalledWith({
      where: { requestedBy: { userId: "u1" } },
      data: { requestNotes: null },
    });
  });
});
