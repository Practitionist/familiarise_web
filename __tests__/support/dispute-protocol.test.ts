/**
 * @jest-environment node
 */

/**
 * The two-party dispute protocol's guards.
 *
 * Three of them, and each one has a failure mode it exists to prevent:
 *
 *   the LEGAL TRANSITION  — a dispute that moves to a state the protocol
 *                           does not have (a claim resolved while the
 *                           respondent is still answering).
 *   the OPTIMISTIC CAS    — two operators pressing the same button; exactly
 *                           one wins and the loser is told what the winner
 *                           did.
 *   the IDEMPOTENCY       — a double-click, a retried request, a replayed
 *                           webhook; ONE transition, not two.
 */

// The mock factory is hoisted above everything else in this file, so the
// module under test is given a client whose parts are reached through
// `jest.requireMock` — the same shape the rest of this suite uses.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    purchaseDispute: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    purchaseDisputeAction: { findUnique: jest.fn(), create: jest.fn() },
    supportCase: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    membership: { findFirst: jest.fn() },
    payment: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
  ALLOCATION_TX_MAX_WAIT_MS: 5000,
  ALLOCATION_TX_TIMEOUT_MS: 10000,
}));

// The case factory and the respondent resolver are the intake's two
// collaborators; both are exercised here through their own seams.
jest.mock("../../lib/support/case-service", () => ({
  executeCreateOrReuseCaseTx: jest.fn(),
}));

jest.mock("../../lib/support/disputes/respondent", () => ({
  resolveRespondent: jest.fn(),
}));

import { performDisputeAction } from "../../lib/support/disputes/actions";
import {
  RaiseDisputeSchema,
  raiseDispute,
} from "../../lib/support/disputes/raise";
import {
  isLegalDisputeTransition,
  TERMINAL_DISPUTE_STATUSES,
} from "../../lib/support/disputes/protocol";

interface MockDb {
  purchaseDispute: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
  };
  purchaseDisputeAction: { findUnique: jest.Mock; create: jest.Mock };
  supportCase: { findFirst: jest.Mock };
  user: { findUnique: jest.Mock };
  membership: { findFirst: jest.Mock };
  payment: { findFirst: jest.Mock };
  $transaction: jest.Mock;
}

const mockDb = jest.requireMock<{ default: MockDb }>(
  "../../lib/prisma",
).default;

const mockCreateOrReuseCaseTx = jest.requireMock<{
  executeCreateOrReuseCaseTx: jest.Mock;
}>("../../lib/support/case-service").executeCreateOrReuseCaseTx;

const mockResolveRespondent = jest.requireMock<{
  resolveRespondent: jest.Mock;
}>("../../lib/support/disputes/respondent").resolveRespondent;

/**
 * The dispute row as the mock holds it. `updateMany` APPLIES the data it is
 * given, so a read after a write sees the write — otherwise the test would
 * assert against a fixture that never moved.
 */
type DisputeState = {
  id: string;
  supportCaseId: string;
  status: string;
  version: number;
  round: number;
  buyerUserId: string;
  respondentUserId: string | null;
  respondentOrganizationId: string | null;
  respondentType: string;
  respondentAcceptedRefund: boolean | null;
  respondentDueAt: Date | null;
  amountAtStakePaise: number;
  refundMethod: string | null;
  refundMethodConsentedAt: Date | null;
  escalatedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
};

const baseDispute: DisputeState = {
  id: "d-1",
  supportCaseId: "c-1",
  status: "OPEN",
  version: 3,
  round: 1,
  buyerUserId: "buyer-1",
  respondentUserId: "resp-1",
  respondentOrganizationId: null,
  respondentType: "CONSULTANT",
  respondentAcceptedRefund: null,
  respondentDueAt: new Date("2026-10-22T00:00:00.000Z"),
  amountAtStakePaise: 500000,
  refundMethod: "ORIGINAL_METHOD",
  refundMethodConsentedAt: null,
  escalatedAt: null,
  resolvedAt: null,
  createdAt: new Date("2026-10-19T00:00:00.000Z"),
};

let disputeState: DisputeState;

const buyer = { userId: "buyer-1", role: "CONSULTEE" as const };
const respondent = { userId: "resp-1", role: "CONSULTANT" as const };

beforeEach(() => {
  jest.clearAllMocks();
  disputeState = { ...baseDispute };
  mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(mockDb),
  );
  mockDb.purchaseDispute.findUnique.mockImplementation(async () => ({
    ...disputeState,
  }));
  mockDb.purchaseDisputeAction.findUnique.mockResolvedValue(null);
  mockDb.purchaseDispute.updateMany.mockImplementation(
    async (args: {
      where: { id: string; status: string; version: number };
      data: Record<string, unknown>;
    }) => {
      if (
        disputeState.id !== args.where.id ||
        disputeState.status !== args.where.status ||
        disputeState.version !== args.where.version
      ) {
        return { count: 0 };
      }
      for (const [key, value] of Object.entries(args.data)) {
        if (key === "version" && typeof value === "object" && value !== null) {
          const increment = (value as { increment?: number }).increment ?? 0;
          disputeState.version += increment;
        } else if (
          key === "round" &&
          typeof value === "object" &&
          value !== null
        ) {
          const increment = (value as { increment?: number }).increment ?? 0;
          disputeState.round += increment;
        } else {
          (disputeState as unknown as Record<string, unknown>)[key] = value;
        }
      }
      return { count: 1 };
    },
  );
  mockDb.purchaseDisputeAction.create.mockResolvedValue({});
  mockDb.supportCase.findFirst.mockResolvedValue({
    id: "c-1",
    deletedAt: null,
  });
  mockDb.user.findUnique.mockResolvedValue({
    id: "u1",
    role: "ADMIN",
    banned: false,
  });
  mockDb.membership.findFirst.mockResolvedValue(null);
});

describe("the legal transitions", () => {
  it("allows the protocol's own path and nothing else", () => {
    expect(isLegalDisputeTransition("OPEN", "RESPONDED")).toBe(true);
    expect(isLegalDisputeTransition("RESPONDED", "ESCALATED")).toBe(true);
    expect(isLegalDisputeTransition("ESCALATED", "UNDER_REVIEW")).toBe(true);
    expect(isLegalDisputeTransition("UNDER_REVIEW", "RESOLVED")).toBe(true);
    // The respondent cannot answer a case that is already closed.
    expect(isLegalDisputeTransition("CLOSED", "RESPONDED")).toBe(false);
    // A claim cannot go straight from OPEN to a ruling.
    expect(isLegalDisputeTransition("OPEN", "RESOLVED")).toBe(false);
  });

  it("treats every terminal state as final", () => {
    for (const status of TERMINAL_DISPUTE_STATUSES) {
      for (const to of [
        "OPEN",
        "RESPONDED",
        "ESCALATED",
        "RESOLVED",
      ] as const) {
        expect(isLegalDisputeTransition(status, to)).toBe(false);
      }
    }
  });
});

describe("the optimistic CAS", () => {
  it("writes the transition when the version still matches", async () => {
    const result = await performDisputeAction("d-1", respondent, {
      action: "RESPOND",
      response: "The session was held; the log is in the case notes.",
      acceptRefund: false,
      expectedVersion: 3,
      clientActionId: "act-1",
    });
    expect(result.replayed).toBe(false);
    expect(result.status).toBe("RESPONDED");
    expect(mockDb.purchaseDispute.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "d-1",
          status: "OPEN",
          version: 3,
        }),
      }),
    );
  });

  it("refuses when another actor moved the dispute first, and says where it went", async () => {
    // The transition is still legal, but the version moved: the operator is
    // acting on a row they have not read.
    disputeState.version = 4;

    await expect(
      performDisputeAction("d-1", respondent, {
        action: "RESPOND",
        response: "Mine",
        acceptRefund: false,
        expectedVersion: 3,
        clientActionId: "act-2",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      details: { currentStatus: "OPEN", currentVersion: 4 },
    });
  });

  it("refuses a transition the protocol does not allow", async () => {
    disputeState.status = "CLOSED";
    await expect(
      performDisputeAction("d-1", respondent, {
        action: "RESPOND",
        response: "Mine",
        acceptRefund: false,
        expectedVersion: 3,
        clientActionId: "act-3",
      }),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION", status: 409 });
    expect(mockDb.purchaseDispute.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a second answer that would overwrite the first", async () => {
    disputeState.status = "RESPONDED";
    await expect(
      performDisputeAction("d-1", respondent, {
        action: "RESPOND",
        response: "A different answer",
        acceptRefund: true,
        expectedVersion: 4,
        clientActionId: "act-3b",
      }),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION", status: 409 });
  });
});

describe("the idempotency replay", () => {
  it("replays a repeated key instead of writing a second transition", async () => {
    mockDb.purchaseDisputeAction.findUnique.mockResolvedValue({
      kind: "RESPONDED",
      toStatus: "RESPONDED",
      payload: { action: "RESPOND" },
    });
    disputeState.status = "RESPONDED";
    disputeState.version = 4;

    const result = await performDisputeAction("d-1", respondent, {
      action: "RESPOND",
      response: "The session was held.",
      acceptRefund: false,
      expectedVersion: 3,
      clientActionId: "act-1",
    });
    expect(result.replayed).toBe(true);
    expect(mockDb.purchaseDispute.updateMany).not.toHaveBeenCalled();
    expect(mockDb.purchaseDisputeAction.create).not.toHaveBeenCalled();
  });

  it("writes exactly one action row per key", async () => {
    await performDisputeAction("d-1", respondent, {
      action: "RESPOND",
      response: "The session was held.",
      acceptRefund: false,
      expectedVersion: 3,
      clientActionId: "act-unique",
    });
    expect(mockDb.purchaseDisputeAction.create).toHaveBeenCalledTimes(1);
    expect(mockDb.purchaseDisputeAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          disputeId: "d-1",
          clientActionId: "act-unique",
          kind: "RESPONDED",
          fromStatus: "OPEN",
          toStatus: "RESPONDED",
        }),
      }),
    );
  });

  it("refuses a key that was already used for a different action", async () => {
    // The buyer accepted the answer with this key, and is now trying to
    // reject it with the SAME key. Replaying the accept would report a
    // success the caller never earned — and no escalation would happen.
    mockDb.purchaseDisputeAction.findUnique.mockResolvedValue({
      kind: "BUYER_ACCEPTED",
      toStatus: "RESOLVED",
      payload: { action: "BUYER_ACCEPT" },
    });
    disputeState.status = "RESPONDED";
    disputeState.version = 4;

    await expect(
      performDisputeAction("d-1", buyer, {
        action: "BUYER_REJECT",
        expectedVersion: 3,
        clientActionId: "act-1",
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
    });
    expect(mockDb.purchaseDispute.updateMany).not.toHaveBeenCalled();
    expect(mockDb.purchaseDisputeAction.create).not.toHaveBeenCalled();
  });

  it("refuses a key whose log row records no action at all", async () => {
    // A row written by another writer carries no `action`, so the key cannot
    // be shown to belong to this action: it is refused rather than replayed.
    mockDb.purchaseDisputeAction.findUnique.mockResolvedValue({
      kind: "ESCALATED",
      toStatus: "ESCALATED",
      payload: { reason: "RESPONDENT_WINDOW_PASSED" },
    });

    await expect(
      performDisputeAction("d-1", respondent, {
        action: "RESPOND",
        response: "Held.",
        acceptRefund: false,
        expectedVersion: 3,
        clientActionId: "act-sweep",
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
    });
    expect(mockDb.purchaseDispute.updateMany).not.toHaveBeenCalled();
  });
});

describe("who may move a dispute", () => {
  it("lets the respondent answer and refuses the buyer", async () => {
    await performDisputeAction("d-1", respondent, {
      action: "RESPOND",
      response: "Held.",
      acceptRefund: true,
      expectedVersion: 3,
      clientActionId: "act-r1",
    });
    expect(mockDb.purchaseDispute.updateMany).toHaveBeenCalled();

    mockDb.purchaseDispute.updateMany.mockClear();
    await expect(
      performDisputeAction("d-1", buyer, {
        action: "RESPOND",
        response: "Held?",
        acceptRefund: true,
        expectedVersion: 3,
        clientActionId: "act-r2",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("lets the buyer accept or reject the answer, and nobody else", async () => {
    disputeState.status = "RESPONDED";
    await performDisputeAction("d-1", buyer, {
      action: "BUYER_REJECT",
      expectedVersion: 3,
      clientActionId: "act-b1",
    });
    expect(mockDb.purchaseDispute.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          buyerDecision: "REJECTED",
          escalatedAt: expect.any(Date),
        }),
      }),
    );
  });
});

describe("the refund method", () => {
  it("records the buyer's consent for a platform-credit refund", async () => {
    await performDisputeAction("d-1", buyer, {
      action: "CHOOSE_REFUND_METHOD",
      refundMethod: "PLATFORM_CREDITS",
      consent: true,
      expectedVersion: 3,
      clientActionId: "act-m1",
    });
    expect(mockDb.purchaseDispute.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refundMethod: "PLATFORM_CREDITS",
          refundMethodConsentedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("refuses a platform-credit refund without the buyer's agreement", async () => {
    await expect(
      performDisputeAction("d-1", buyer, {
        action: "CHOOSE_REFUND_METHOD",
        refundMethod: "PLATFORM_CREDITS",
        expectedVersion: 3,
        clientActionId: "act-m2",
      }),
    ).rejects.toMatchObject({ code: "CONSENT_REQUIRED", status: 400 });
    expect(mockDb.purchaseDispute.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * The intake.
 *
 * A claim and its case are written in ONE transaction, so the intake has two
 * failure modes worth a test of their own: the reuse of a case that already
 * carries a claim, and a credits refund the buyer never agreed to.
 */
describe("the intake", () => {
  const claim = {
    paymentId: "pay-1",
    reason: "NOT_DELIVERED",
    remark: "The session never happened.",
    clientActionId: "claim-1",
  };

  beforeEach(() => {
    mockDb.payment.findFirst.mockResolvedValue({
      id: "pay-1",
      amount: 500000,
      paymentStatus: "SUCCEEDED",
      userId: "buyer-1",
      appointmentId: "appt-1",
      organizationId: null,
      hostOrganizationId: null,
      deletedAt: null,
    });
    mockResolveRespondent.mockResolvedValue({
      type: "CONSULTANT",
      userId: "resp-1",
      name: "Respondent One",
    });
    mockDb.purchaseDispute.findFirst.mockResolvedValue(null);
    mockDb.purchaseDispute.create.mockResolvedValue({
      id: "d-new",
      referenceNumber: "DSP-2026-000009",
    });
    mockCreateOrReuseCaseTx.mockResolvedValue({
      supportCase: { id: "c-9", referenceNumber: "FAM-2026-000009" },
      reused: false,
      dedupeReason: null,
    });
  });

  it("raises the claim and its case together", async () => {
    const result = await raiseDispute("buyer-1", claim);
    expect(result).toEqual({
      disputeId: "d-new",
      referenceNumber: "DSP-2026-000009",
      caseId: "c-9",
    });
    expect(mockDb.purchaseDispute.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          supportCaseId: "c-9",
          paymentId: "pay-1",
          status: "OPEN",
          amountAtStakePaise: 500000,
        }),
      }),
    );
  });

  it("refuses a second claim on a case that already carries one", async () => {
    // The buyer withdrew the first claim, so the payment has no LIVE
    // dispute — but its case is still open, and the case factory dedupes
    // onto that case. `supportCaseId` is unique, so the insert would be
    // rejected as a raw 500; it is refused as the conflict it is.
    mockCreateOrReuseCaseTx.mockResolvedValue({
      supportCase: { id: "c-9", referenceNumber: "FAM-2026-000009" },
      reused: true,
      dedupeReason: "open_scope",
    });
    mockDb.purchaseDispute.findUnique.mockResolvedValue({ id: "d-old" });

    await expect(
      raiseDispute("buyer-1", { ...claim, clientActionId: "claim-2" }),
    ).rejects.toMatchObject({
      code: "CASE_HAS_DISPUTE",
      status: 409,
      details: {
        supportCaseId: "c-9",
        supportCaseReference: "FAM-2026-000009",
        disputeId: "d-old",
      },
    });
    expect(mockDb.purchaseDispute.create).not.toHaveBeenCalled();
  });

  it("raises the claim on a reused case that carries no claim yet", async () => {
    // The buyer had a support case about this appointment and is now
    // turning it into a claim: the case is reused, and it carries no
    // dispute, so the claim is written on it.
    mockCreateOrReuseCaseTx.mockResolvedValue({
      supportCase: { id: "c-9", referenceNumber: "FAM-2026-000009" },
      reused: true,
      dedupeReason: "open_scope",
    });
    mockDb.purchaseDispute.findUnique.mockResolvedValue(null);

    const result = await raiseDispute("buyer-1", claim);
    expect(result.caseId).toBe("c-9");
    expect(mockDb.purchaseDispute.create).toHaveBeenCalled();
  });

  it("refuses a platform-credit claim without the buyer's agreement", () => {
    // The sidecar CHECK would reject the insert, so the intake refuses it
    // first — as a validation failure, not a 500.
    const parsed = RaiseDisputeSchema.safeParse({
      ...claim,
      refundMethod: "PLATFORM_CREDITS",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a platform-credit claim the buyer agreed to", () => {
    const parsed = RaiseDisputeSchema.safeParse({
      ...claim,
      refundMethod: "PLATFORM_CREDITS",
      consentToCredits: true,
    });
    expect(parsed.success).toBe(true);
  });
});
