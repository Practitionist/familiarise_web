/**
 * @jest-environment node
 *
 * #1839 — Backoffice Referral Credits API tests:
 * - GET /api/admin/referrals/credits (Staff & Admin read, search/filter)
 * - POST /api/admin/referrals/credits (Admin-only issue with OpsActionLog + idempotency)
 * - POST /api/admin/referrals/credits/[creditId]/reverse (Admin-only reversal with OpsActionLog + balance constraint)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "../../lib/auth/backoffice-permissions";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/api/after-safe", () => ({
  scheduleAfter: jest.fn(),
}));

let currentMockUser: {
  id: string;
  role: "ADMIN" | "STAFF" | "CONSULTEE";
} | null = {
  id: "admin_1",
  role: "ADMIN",
};

jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async (surface: BackofficeSurface) => {
    if (!currentMockUser) {
      return {
        error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      };
    }
    if (!hasBackofficePermission(currentMockUser.role, surface)) {
      return {
        error: NextResponse.json(
          { error: "Forbidden — insufficient back-office permissions" },
          { status: 403 },
        ),
      };
    }
    return {
      session: { user: currentMockUser },
    };
  }),
}));

const mockReferralCreditFindMany = jest.fn();
const mockReferralCreditCount = jest.fn();
const mockReferralCreditFindUnique = jest.fn();
const mockReferralCreditFindUniqueOrThrow = jest.fn();
const mockReferralCreditCreate = jest.fn();
const mockReferralCreditUpdate = jest.fn();
const mockReferralCreditUpdateMany = jest.fn();
const mockUserFindUnique = jest.fn();
const mockUserFindFirst = jest.fn();
const mockOpsActionLogCreate = jest.fn();

const mockPostLedgerTxn = jest.fn();
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...args: unknown[]) => mockPostLedgerTxn(...args),
}));

const mockTx = {
  $executeRaw: jest.fn().mockResolvedValue(0),
  referralCredit: {
    findUnique: mockReferralCreditFindUnique,
    findUniqueOrThrow: mockReferralCreditFindUniqueOrThrow,
    create: mockReferralCreditCreate,
    update: mockReferralCreditUpdate,
    updateMany: mockReferralCreditUpdateMany,
  },
  user: {
    findUnique: mockUserFindUnique,
    findFirst: mockUserFindFirst,
  },
  opsActionLog: {
    create: mockOpsActionLogCreate,
  },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    referralCredit: {
      findMany: (...args: unknown[]) => mockReferralCreditFindMany(...args),
      count: (...args: unknown[]) => mockReferralCreditCount(...args),
      findUnique: (...args: unknown[]) => mockReferralCreditFindUnique(...args),
    },
    opsActionLog: {
      create: (...args: unknown[]) => mockOpsActionLogCreate(...args),
    },
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  },
}));

import {
  GET as listCredits,
  POST as issueCredit,
} from "../../app/api/admin/referrals/credits/route";
import { POST as reverseCredit } from "../../app/api/admin/referrals/credits/[creditId]/reverse/route";

describe("#1839 — Backoffice Referral Credits API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentMockUser = { id: "admin_1", role: "ADMIN" };
    mockOpsActionLogCreate.mockResolvedValue({ id: "ops_1" });
  });

  describe("GET /api/admin/referrals/credits", () => {
    it("allows STAFF to read and filter referral credits and usages", async () => {
      currentMockUser = { id: "staff_1", role: "STAFF" };
      mockReferralCreditFindMany.mockResolvedValue([
        {
          id: "rc_1",
          userId: "u_1",
          amount: 50000,
          usedAmount: 20000,
          remainingAmount: 30000,
          currency: "INR",
          source: "REFERRAL_BONUS",
          referralId: "ref_1",
          expiresAt: null,
          usedAt: null,
          idempotencyKey: null,
          reason: null,
          issuedBy: null,
          reversedAt: null,
          reversedBy: null,
          reversedReason: null,
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          user: {
            id: "u_1",
            name: "Asha Learner",
            email: "asha@example.com",
            referralCode: { code: "ASHA50", customCode: null },
          },
          usages: [
            {
              id: "rcu_1",
              paymentId: "pay_1",
              amount: 20000,
              originalAmount: 20000,
              restoredAmount: 0,
              createdAt: new Date("2026-04-02T00:00:00.000Z"),
            },
          ],
        },
      ]);
      mockReferralCreditCount.mockResolvedValue(1);

      const req = new NextRequest(
        "http://localhost/api/admin/referrals/credits?q=asha&source=REFERRAL_BONUS&status=ACTIVE",
      );
      const res = await listCredits(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].usages).toHaveLength(1);
      expect(mockReferralCreditFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              { source: "REFERRAL_BONUS" },
              expect.objectContaining({
                reversedAt: null,
                remainingAmount: { gt: 0 },
              }),
            ]),
          }),
        }),
      );
    });

    it("rejects non-operator roles with 403", async () => {
      currentMockUser = { id: "user_1", role: "CONSULTEE" };
      const req = new NextRequest(
        "http://localhost/api/admin/referrals/credits",
      );
      const res = await listCredits(req);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/admin/referrals/credits (Issue Goodwill Credit)", () => {
    it("forbids STAFF from issuing credits (403)", async () => {
      currentMockUser = { id: "staff_1", role: "STAFF" };
      const req = new NextRequest(
        "http://localhost/api/admin/referrals/credits",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: "u_1",
            amountPaise: 50000,
            source: "COMPENSATION",
            reason: "Ticket #101 — missed session compensation",
          }),
        },
      );
      const res = await issueCredit(req, {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(403);
      expect(mockReferralCreditCreate).not.toHaveBeenCalled();
    });

    it("requires a valid audit reason (>= 5 characters)", async () => {
      const req = new NextRequest(
        "http://localhost/api/admin/referrals/credits",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: "u_1",
            amountPaise: 50000,
            source: "COMPENSATION",
            reason: "ok",
          }),
        },
      );
      const res = await issueCredit(req, {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(400);
      expect(mockReferralCreditCreate).not.toHaveBeenCalled();
    });

    it("issues a COMPENSATION credit, stamps issuedBy & idempotencyKey, and records OpsActionLog", async () => {
      mockUserFindUnique.mockResolvedValue({
        id: "u_1",
        name: "Asha Learner",
        email: "asha@example.com",
      });
      mockReferralCreditFindUnique.mockResolvedValue(null);
      mockReferralCreditCreate.mockResolvedValue({
        id: "rc_new",
        userId: "u_1",
        amount: 50000,
        usedAmount: 0,
        remainingAmount: 50000,
        currency: "INR",
        source: "COMPENSATION",
        idempotencyKey: "idem_ticket_101",
        reason: "Ticket #101 — missed session compensation",
        issuedBy: "admin_1",
        user: { id: "u_1", name: "Asha Learner", email: "asha@example.com" },
        usages: [],
      });

      const req = new NextRequest(
        "http://localhost/api/admin/referrals/credits",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: "u_1",
            amountPaise: 50000,
            source: "COMPENSATION",
            idempotencyKey: "idem_ticket_101",
            reason: "Ticket #101 — missed session compensation",
          }),
        },
      );

      const res = await issueCredit(req, {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.credit.id).toBe("rc_new");
      expect(mockReferralCreditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "u_1",
            amount: 50000,
            usedAmount: 0,
            remainingAmount: 50000,
            currency: "INR",
            source: "COMPENSATION",
            idempotencyKey: "idem_ticket_101",
            reason: "Ticket #101 — missed session compensation",
            issuedBy: "admin_1",
            state: "VESTED",
            vestedAt: expect.any(Date),
          }),
        }),
      );
      expect(mockPostLedgerTxn).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({ idempotencyKey: "referral-issue:rc_new" }),
      );
      expect(mockOpsActionLogCreate).toHaveBeenCalledTimes(1);
      expect(mockOpsActionLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: "admin_1",
            actorRole: "ADMIN",
            surface: "referrals.manage",
            action: "referrals.credit.issue",
            targetKind: "ReferralCredit",
            targetId: "rc_new",
            reason: "Ticket #101 — missed session compensation",
          }),
        }),
      );
    });

    it("rejects zero or negative amountPaise and non-INR currency with 400", async () => {
      for (const invalidAmount of [0, -500]) {
        const req = new NextRequest(
          "http://localhost/api/admin/referrals/credits",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: "u_1",
              amountPaise: invalidAmount,
              source: "COMPENSATION",
              reason: "Invalid amount test",
            }),
          },
        );
        const res = await issueCredit(req, {
          params: Promise.resolve({}),
        });
        expect(res.status).toBe(400);
      }

      const usdReq = new NextRequest(
        "http://localhost/api/admin/referrals/credits",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: "u_1",
            amountPaise: 50000,
            currency: "USD",
            source: "COMPENSATION",
            reason: "Non-INR currency test",
          }),
        },
      );
      const usdRes = await issueCredit(usdReq, {
        params: Promise.resolve({}),
      });
      expect(usdRes.status).toBe(400);
      expect(mockReferralCreditCreate).not.toHaveBeenCalled();
    });

    it("replays matching idempotencyKey with 200 { replayed: true } and rejects mismatched payload with 409 (pre-check and P2002 race)", async () => {
      mockUserFindUnique.mockResolvedValue({
        id: "u_1",
        name: "Asha Learner",
        email: "asha@example.com",
      });
      const existingMatchingCredit = {
        id: "rc_existing",
        userId: "u_1",
        amount: 50000,
        usedAmount: 0,
        remainingAmount: 50000,
        currency: "INR",
        source: "MANUAL",
        expiresAt: null,
        idempotencyKey: "idem_match",
        reason: "Idempotent retry with identical payload",
        user: { id: "u_1", name: "Asha Learner", email: "asha@example.com" },
        usages: [],
      };
      mockReferralCreditFindUnique.mockResolvedValueOnce(
        existingMatchingCredit,
      );

      const replayReq = new NextRequest(
        "http://localhost/api/admin/referrals/credits",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: "u_1",
            amountPaise: 50000,
            source: "MANUAL",
            idempotencyKey: "idem_match",
            reason: "Idempotent retry with identical payload",
          }),
        },
      );
      const replayRes = await issueCredit(replayReq, {
        params: Promise.resolve({}),
      });
      expect(replayRes.status).toBe(200);
      const replayBody = await replayRes.json();
      expect(replayBody.replayed).toBe(true);
      expect(replayBody.credit.id).toBe("rc_existing");

      // Mismatched payload on same idempotencyKey -> 409 Conflict
      mockReferralCreditFindUnique.mockResolvedValueOnce(
        existingMatchingCredit,
      );
      const mismatchReq = new NextRequest(
        "http://localhost/api/admin/referrals/credits",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: "u_1",
            amountPaise: 75000,
            source: "MANUAL",
            idempotencyKey: "idem_match",
            reason: "Different amount on same idempotency key",
          }),
        },
      );
      const mismatchRes = await issueCredit(mismatchReq, {
        params: Promise.resolve({}),
      });
      expect(mismatchRes.status).toBe(409);
      const mismatchBody = await mismatchRes.json();
      expect(mismatchBody.code).toBe("DUPLICATE_IDEMPOTENCY_KEY");

      // Mismatched reason with identical amount on same idempotencyKey -> 409 Conflict
      mockReferralCreditFindUnique.mockResolvedValueOnce(
        existingMatchingCredit,
      );
      const mismatchReasonReq = new NextRequest(
        "http://localhost/api/admin/referrals/credits",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: "u_1",
            amountPaise: 50000,
            source: "MANUAL",
            idempotencyKey: "idem_match",
            reason: "Different audit reason on same idempotency key",
          }),
        },
      );
      const mismatchReasonRes = await issueCredit(mismatchReasonReq, {
        params: Promise.resolve({}),
      });
      expect(mismatchReasonRes.status).toBe(409);
      const mismatchReasonBody = await mismatchReasonRes.json();
      expect(mismatchReasonBody.code).toBe("DUPLICATE_IDEMPOTENCY_KEY");

      // Concurrent P2002 unique violation on idempotencyKey with mismatched winner -> 409
      mockReferralCreditFindUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          ...existingMatchingCredit,
          amount: 99000,
        });
      mockReferralCreditCreate.mockRejectedValueOnce({
        code: "P2002",
        meta: { target: ["idempotencyKey"] },
      });

      const reqRace = new NextRequest(
        "http://localhost/api/admin/referrals/credits",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: "u_1",
            amountPaise: 50000,
            source: "MANUAL",
            idempotencyKey: "idem_race",
            reason: "Concurrent duplicate submission test",
          }),
        },
      );
      const resRace = await issueCredit(reqRace, {
        params: Promise.resolve({}),
      });
      expect(resRace.status).toBe(409);
      const bodyRace = await resRace.json();
      expect(bodyRace.code).toBe("DUPLICATE_IDEMPOTENCY_KEY");
    });
  });

  describe("POST /api/admin/referrals/credits/[creditId]/reverse", () => {
    it("forbids STAFF from reversing credits (403)", async () => {
      currentMockUser = { id: "staff_1", role: "STAFF" };
      const req = new NextRequest(
        "http://localhost/api/admin/referrals/credits/rc_1/reverse",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "Attempting reversal as staff",
          }),
        },
      );
      const res = await reverseCredit(req, {
        params: Promise.resolve({ creditId: "rc_1" }),
      });
      expect(res.status).toBe(403);
      expect(mockReferralCreditUpdateMany).not.toHaveBeenCalled();
    });

    it("reverses unused balance via CAS updateMany while preserving usedAmount to satisfy referral_credit_balance_consistent", async () => {
      mockReferralCreditFindUnique.mockResolvedValue({
        id: "rc_1",
        userId: "u_1",
        amount: 50000,
        usedAmount: 20000,
        remainingAmount: 30000,
        currency: "INR",
        reversedAt: null,
        state: "VESTED",
        vestedAt: new Date("2026-04-01T00:00:00.000Z"),
      });
      mockReferralCreditUpdateMany.mockResolvedValue({ count: 1 });
      mockReferralCreditFindUniqueOrThrow.mockResolvedValue({
        id: "rc_1",
        userId: "u_1",
        amount: 20000,
        usedAmount: 20000,
        remainingAmount: 0,
        currency: "INR",
        reversedAt: new Date("2026-04-10T00:00:00.000Z"),
        reversedBy: "admin_1",
        reversedReason: "Clawback of unused promotional portion",
        user: { id: "u_1", name: "Asha", email: "asha@example.com" },
        usages: [],
      });

      const req = new NextRequest(
        "http://localhost/api/admin/referrals/credits/rc_1/reverse",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "Clawback of unused promotional portion",
          }),
        },
      );

      const res = await reverseCredit(req, {
        params: Promise.resolve({ creditId: "rc_1" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reversedAmountPaise).toBe(30000);
      expect(mockReferralCreditUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "rc_1",
            reversedAt: null,
            state: "VESTED",
            usedAmount: 20000,
            remainingAmount: 30000,
          },
          data: expect.objectContaining({
            amount: 20000,
            remainingAmount: 0,
            reversedBy: "admin_1",
            reversedReason: "Clawback of unused promotional portion",
            reversedAt: expect.any(Date),
          }),
        }),
      );
      expect(mockReferralCreditFindUniqueOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "rc_1" },
        }),
      );
      expect(mockOpsActionLogCreate).toHaveBeenCalledTimes(1);
    });

    it("rejects reversal with 409 when credit is already reversed, has 0 remaining balance, or fails CAS (CREDIT_CHANGED)", async () => {
      mockReferralCreditFindUnique.mockResolvedValueOnce({
        id: "rc_already",
        userId: "u_1",
        amount: 0,
        usedAmount: 0,
        remainingAmount: 0,
        reversedAt: new Date("2026-04-05T00:00:00.000Z"),
      });

      const req1 = new NextRequest(
        "http://localhost/api/admin/referrals/credits/rc_already/reverse",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "Second reversal attempt",
          }),
        },
      );
      const res1 = await reverseCredit(req1, {
        params: Promise.resolve({ creditId: "rc_already" }),
      });
      expect(res1.status).toBe(409);
      expect((await res1.json()).code).toBe("CREDIT_ALREADY_REVERSED");

      mockReferralCreditFindUnique.mockResolvedValueOnce({
        id: "rc_exhausted",
        userId: "u_1",
        amount: 50000,
        usedAmount: 50000,
        remainingAmount: 0,
        reversedAt: null,
      });

      const req2 = new NextRequest(
        "http://localhost/api/admin/referrals/credits/rc_exhausted/reverse",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "Reversing fully used credit",
          }),
        },
      );
      const res2 = await reverseCredit(req2, {
        params: Promise.resolve({ creditId: "rc_exhausted" }),
      });
      expect(res2.status).toBe(409);
      expect((await res2.json()).code).toBe("NO_REMAINING_BALANCE");

      // CAS conflict (count === 0)
      mockReferralCreditFindUnique.mockResolvedValueOnce({
        id: "rc_race",
        userId: "u_1",
        amount: 50000,
        usedAmount: 10000,
        remainingAmount: 40000,
        reversedAt: null,
      });
      mockReferralCreditUpdateMany.mockResolvedValueOnce({ count: 0 });

      const req3 = new NextRequest(
        "http://localhost/api/admin/referrals/credits/rc_race/reverse",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "Concurrent reversal or spend race",
          }),
        },
      );
      const res3 = await reverseCredit(req3, {
        params: Promise.resolve({ creditId: "rc_race" }),
      });
      expect(res3.status).toBe(409);
      expect((await res3.json()).code).toBe("CREDIT_CHANGED");
    });
  });
});
