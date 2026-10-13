/**
 * @jest-environment node
 */

/**
 * #1020-1 — a freeze must remember where the row came from, whoever froze it.
 *
 * The dispute path has always recorded `preDisputeStatus` and restored it on a
 * WON/CLOSED release. Moderation's ban hold wrote the column for nobody, and the
 * operator release never read it, so a PENDING_TRUST row frozen by a ban came
 * back READY — money out to a consultant whose sponsoring org has never been
 * verified or paid, with the invoice-fraud park never seeing the row again.
 *
 * These pin the two halves: the ban records the prior, and the release honours
 * it (PENDING_TRUST → PENDING_TRUST, not READY), with the NULL-prior fallback
 * documented as the hold-window rule the release has always used.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { moderationAction: { update: jest.fn(async () => ({})) } },
}));
jest.mock("../../lib/stream-client", () => ({
  __esModule: true,
  getStreamChatClient: jest.fn(() => ({
    revokeUserToken: jest.fn(async () => undefined),
    deactivateUser: jest.fn(async () => undefined),
  })),
  withStreamCircuitBreaker: jest.fn(async (op: () => Promise<unknown>) => op()),
  isExpectedStreamError: jest.fn(() => false),
}));
jest.mock("../../lib/novu", () => ({
  notifyModerationWarning: jest.fn(async () => ({ success: true })),
  notifyAccountSuspended: jest.fn(async () => ({ success: true })),
  notifyAccountBanned: jest.fn(async () => ({ success: true })),
  notifyVerificationStatusChanged: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { REQUEST: 5_000 },
  sendAccountSuspendedEmail: jest.fn(async () => ({
    sent: 0,
    skipped: 1,
    failed: 0,
  })),
  sendAccountBannedEmail: jest.fn(async () => ({
    sent: 0,
    skipped: 1,
    failed: 0,
  })),
}));
jest.mock("../../lib/moderation/cancel-user-engagements", () => ({
  __esModule: true,
  cancelFutureEngagementsForUser: jest.fn(async () => ({
    engagementsCancelled: 0,
    attendeeRemovals: 0,
    refundsIssued: 0,
    refundedPaise: 0,
    failures: [],
    remaining: [],
  })),
}));
jest.mock("../../lib/collaborators/service", () => ({
  revokeCollaboratorAccess: jest.fn(async () => ({ success: true })),
}));

import { EarningStatus } from "@prisma/client";
import { applyTransactionalEffects } from "@/lib/moderation/side-effects";
import { releaseHeldEarnings } from "@/lib/payments/payouts/earnings-hold-ops";

const banInput = {
  actionType: "USER_BANNED" as const,
  report: {
    id: "r1",
    type: "PROFILE" as const,
    targetUserId: "u1",
    reviewId: null,
  },
  staffUserId: "admin-1",
};

// ── the ban hold ─────────────────────────────────────────────────────────────

type HoldableRow = { id: string; status: EarningStatus };

function banTx(rows: HoldableRow[]) {
  const state = rows.map((r) => ({ ...r }));
  const updateMany = jest.fn(
    async (args: {
      where: { id: { in: string[] }; status: EarningStatus };
      data: { status: EarningStatus; preDisputeStatus: EarningStatus };
    }) => {
      const matched = state.filter(
        (r) =>
          args.where.id.in.includes(r.id) && r.status === args.where.status,
      );
      for (const r of matched) r.status = args.data.status;
      return { count: matched.length };
    },
  );
  return {
    state,
    updateMany,
    tx: {
      user: {
        update: jest.fn(async () => ({})),
        findUnique: jest.fn(async () => ({ consultantProfileId: "cp-1" })),
      },
      session: { deleteMany: jest.fn(async () => ({ count: 1 })) },
      consultantEarnings: {
        // Honours the HOLDABLE filter the real query carries.
        findMany: jest.fn(
          async (args: { where: { status: { in: EarningStatus[] } } }) =>
            state
              .filter((r) => args.where.status.in.includes(r.status))
              .map((r) => ({ id: r.id, status: r.status })),
        ),
        updateMany,
      },
      collaborator: { updateManyAndReturn: jest.fn(async () => []) },
    } as never,
  };
}

describe("a ban hold records the row's prior status", () => {
  it("stamps preDisputeStatus per source status, so the release can undo the hold exactly", async () => {
    const { tx, updateMany, state } = banTx([
      { id: "e-ready", status: EarningStatus.READY },
      { id: "e-pending", status: EarningStatus.PENDING },
      { id: "e-trust", status: EarningStatus.PENDING_TRUST },
    ]);

    const result = await applyTransactionalEffects(tx, banInput);

    expect(result.earningsHeld).toBe(3);
    expect(state.map((r) => r.status)).toEqual([
      EarningStatus.HELD,
      EarningStatus.HELD,
      EarningStatus.HELD,
    ]);
    // One CAS group per source status, each carrying that status as the prior —
    // the shape the dispute hold uses in app/api/webhooks/utils.ts.
    expect(updateMany.mock.calls.map(([a]) => a.data.preDisputeStatus)).toEqual(
      [EarningStatus.READY, EarningStatus.PENDING, EarningStatus.PENDING_TRUST],
    );
  });

  it("cannot clobber a dispute hold: an already-HELD row is neither read nor rewritten", async () => {
    const { tx, updateMany, state } = banTx([
      { id: "e-trust", status: EarningStatus.PENDING_TRUST },
      // A row the dispute webhook froze, with the prior it recorded there.
      { id: "e-disputed", status: EarningStatus.HELD },
    ]);

    const result = await applyTransactionalEffects(tx, banInput);

    expect(result.earningsHeld).toBe(1);
    for (const [args] of updateMany.mock.calls) {
      expect(args.where.status).not.toBe(EarningStatus.HELD);
      expect(args.where.id.in).not.toContain("e-disputed");
    }
    expect(state.find((r) => r.id === "e-disputed")).toEqual({
      id: "e-disputed",
      status: EarningStatus.HELD,
    });
  });
});

// ── the operator release ─────────────────────────────────────────────────────

type FakeRow = {
  id: string;
  status: EarningStatus;
  holdUntil: Date | null;
  preDisputeStatus: EarningStatus | null;
};

const HELD = EarningStatus.HELD;

function releaseDb(rows: FakeRow[]) {
  const state = rows.map((r) => ({ ...r }));
  const db = {
    consultantEarnings: {
      findMany: jest.fn(async () =>
        state.map((r) => ({
          id: r.id,
          status: r.status,
          holdUntil: r.holdUntil,
          preDisputeStatus: r.preDisputeStatus,
          payment: { refunds: [], disputes: [] },
        })),
      ),
      // Honours the four predicates the release writes into each WHERE.
      updateMany: jest.fn(
        async (args: {
          where: {
            id: { in: string[] };
            status: EarningStatus;
            preDisputeStatus: EarningStatus | null;
            holdUntil?: { lte: Date };
          };
          data: {
            status: EarningStatus;
            preDisputeStatus: EarningStatus | null;
          };
        }) => {
          const matched = state.filter(
            (r) =>
              args.where.id.in.includes(r.id) &&
              r.status === args.where.status &&
              r.preDisputeStatus === args.where.preDisputeStatus &&
              (args.where.holdUntil === undefined ||
                (r.holdUntil !== null &&
                  r.holdUntil <= args.where.holdUntil.lte)),
          );
          for (const r of matched) {
            r.status = args.data.status;
            r.preDisputeStatus = args.data.preDisputeStatus;
          }
          return { count: matched.length };
        },
      ),
    },
  };
  return { db: db as never, state };
}

const matured = new Date(0);
const notYet = new Date("2999-01-01");

describe("releaseHeldEarnings restores the recorded prior", () => {
  it("returns a ban-held PENDING_TRUST row to PENDING_TRUST, never to READY", async () => {
    const { db, state } = releaseDb([
      {
        id: "e1",
        status: HELD,
        holdUntil: matured,
        preDisputeStatus: EarningStatus.PENDING_TRUST,
      },
    ]);

    const result = await releaseHeldEarnings(
      db,
      ["e1"],
      "ban lifted, review clean",
    );

    expect(state[0].status).toBe(EarningStatus.PENDING_TRUST);
    expect(result.trust).toEqual(["e1"]);
    expect(result.ready).toEqual([]);
    // The marker is cleared, as the dispute release does, so the next hold
    // cannot inherit it.
    expect(state[0].preDisputeStatus).toBeNull();
  });

  it("still restores a dispute-held row to its true prior (PENDING stays PENDING)", async () => {
    const { db, state } = releaseDb([
      {
        id: "p",
        status: HELD,
        holdUntil: matured,
        preDisputeStatus: EarningStatus.PENDING,
      },
      {
        id: "r",
        status: HELD,
        holdUntil: matured,
        preDisputeStatus: EarningStatus.READY,
      },
      {
        id: "t",
        status: HELD,
        holdUntil: matured,
        preDisputeStatus: EarningStatus.PENDING_TRUST,
      },
    ]);

    const result = await releaseHeldEarnings(
      db,
      ["p", "r", "t"],
      "dispute won",
    );

    expect(state.map((s) => s.status)).toEqual([
      EarningStatus.PENDING,
      EarningStatus.READY,
      EarningStatus.PENDING_TRUST,
    ]);
    expect(result).toEqual({ ready: ["r"], pending: ["p"], trust: ["t"] });
  });

  it("falls back to the hold-window rule for a NULL prior: READY once matured, PENDING until", async () => {
    const { db, state } = releaseDb([
      {
        id: "matured-row",
        status: HELD,
        holdUntil: matured,
        preDisputeStatus: null,
      },
      {
        id: "waiting-row",
        status: HELD,
        holdUntil: notYet,
        preDisputeStatus: null,
      },
    ]);

    const result = await releaseHeldEarnings(
      db,
      ["matured-row", "waiting-row"],
      "operator hold lifted",
    );

    expect(state.map((s) => s.status)).toEqual([
      EarningStatus.READY,
      EarningStatus.PENDING,
    ]);
    expect(result).toEqual({
      ready: ["matured-row"],
      pending: ["waiting-row"],
      trust: [],
    });
  });

  it("parks a trust-prior row back in the park even when its hold has matured", async () => {
    // The gate is the PRIOR, not the clock: maturity is what force-readies a
    // blank-prior row, and it must not become a maturity signal for a row whose
    // prior says the sponsor has still never paid.
    const { db, state } = releaseDb([
      {
        id: "e1",
        status: HELD,
        holdUntil: matured,
        preDisputeStatus: EarningStatus.PENDING_TRUST,
      },
      {
        id: "e2",
        status: HELD,
        holdUntil: notYet,
        preDisputeStatus: EarningStatus.PENDING_TRUST,
      },
    ]);

    const result = await releaseHeldEarnings(db, ["e1", "e2"], "un-hold");

    expect(state.map((s) => s.status)).toEqual([
      EarningStatus.PENDING_TRUST,
      EarningStatus.PENDING_TRUST,
    ]);
    expect(result.trust).toEqual(["e1", "e2"]);
  });
});
