/**
 * @jest-environment node
 */

/**
 * A hold remembers the row's prior status and each owner releases only its own
 * hold: a ban-held PENDING_TRUST row returns to PENDING_TRUST, a NULL prior
 * follows the hold-window rule, and a dispute release leaves a ban hold in place.
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
jest.mock("../../lib/stream/collaborator-access", () => ({
  driveCollaboratorRevocation: jest.fn(async () => null),
}));

import { EarningStatus, EarningsHoldReason } from "@prisma/client";
import { applyTransactionalEffects } from "@/lib/moderation/side-effects";
import { releaseHeldEarnings } from "@/lib/payments/payouts/earnings-hold-ops";
import {
  placeEarningsHolds,
  releaseEarningsHolds,
} from "@/lib/payments/payouts/earnings-holds";
import {
  createEarningsHoldStore,
  type FakeEarning,
} from "../fixtures/earnings-hold-store";

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

const HELD = EarningStatus.HELD;
const matured = new Date(0);
const notYet = new Date("2999-01-01");

type Row = FakeEarning & {
  consultantProfileId: string;
  payment: { refunds: unknown[]; disputes: unknown[] };
};

function earning(
  id: string,
  status: EarningStatus,
  over: Partial<Row> = {},
): Row {
  return {
    id,
    paymentId: "pay-1",
    consultantProfileId: "cp-1",
    status,
    preHoldStatus: null,
    holdUntil: matured,
    payment: { refunds: [], disputes: [] },
    ...over,
  };
}

function storeWith(rows: Row[]) {
  const store = createEarningsHoldStore<Row>();
  store.consultant.push(...rows);
  const tx = {
    ...store.db,
    user: {
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => ({ consultantProfileId: "cp-1" })),
    },
    session: { deleteMany: jest.fn(async () => ({ count: 1 })) },
    collaborator: { findMany: jest.fn(async () => []) },
  };
  return { store, tx: tx as never };
}

const byId = (
  store: ReturnType<typeof createEarningsHoldStore<Row>>,
  id: string,
) => store.consultant.find((e) => e.id === id)!;

describe("a ban hold records the row's prior status", () => {
  it("freezes every holdable row under one MODERATION hold, keeping each prior", async () => {
    const { store, tx } = storeWith([
      earning("e-ready", EarningStatus.READY),
      earning("e-pending", EarningStatus.PENDING),
      earning("e-trust", EarningStatus.PENDING_TRUST),
    ]);

    const result = await applyTransactionalEffects(tx, banInput);

    expect(result.earningsHeld).toBe(3);
    expect(store.consultant.map((r) => [r.status, r.preHoldStatus])).toEqual([
      [HELD, EarningStatus.READY],
      [HELD, EarningStatus.PENDING],
      [HELD, EarningStatus.PENDING_TRUST],
    ]);
    expect(store.holds.map((h) => [h.reason, h.sourceRef])).toEqual([
      ["MODERATION", "u1"],
      ["MODERATION", "u1"],
      ["MODERATION", "u1"],
    ]);
  });

  it("adds its hold to a dispute-held row without overwriting the dispute's prior", async () => {
    const { store, tx } = storeWith([
      earning("e-disputed", EarningStatus.READY),
    ]);
    await placeEarningsHolds(store.db as never, "consultant", ["e-disputed"], {
      reason: EarningsHoldReason.DISPUTE,
      sourceRef: "disp-row-1",
    });

    await applyTransactionalEffects(tx, banInput);

    expect(byId(store, "e-disputed")).toMatchObject({
      status: HELD,
      preHoldStatus: EarningStatus.READY,
    });
    expect(store.activeReasons("e-disputed")).toEqual([
      "DISPUTE",
      "MODERATION",
    ]);

    // Releasing the dispute leaves the ban's hold, so the money stays frozen.
    await releaseEarningsHolds(
      store.db as never,
      "consultant",
      ["e-disputed"],
      {
        reasons: [EarningsHoldReason.DISPUTE],
        sourceRef: "disp-row-1",
      },
    );
    expect(byId(store, "e-disputed").status).toBe(HELD);
    expect(store.activeReasons("e-disputed")).toEqual(["MODERATION"]);
  });
});

describe("releaseHeldEarnings restores the recorded prior", () => {
  async function opsHeld(rows: Row[]) {
    const ctx = storeWith(rows);
    for (const r of rows) {
      await placeEarningsHolds(ctx.store.db as never, "consultant", [r.id], {
        reason: EarningsHoldReason.OPERATOR,
        sourceRef: `ops-${r.id}`,
      });
    }
    return ctx;
  }

  it.each([
    [EarningStatus.PENDING_TRUST, matured, EarningStatus.PENDING_TRUST],
    [EarningStatus.PENDING_TRUST, notYet, EarningStatus.PENDING_TRUST],
    [EarningStatus.PENDING, matured, EarningStatus.PENDING],
    [EarningStatus.READY, notYet, EarningStatus.READY],
  ])(
    "a row held from %s (holdUntil %s) returns to %s",
    async (from, holdUntil, to) => {
      const { store, tx } = await opsHeld([earning("e1", from, { holdUntil })]);

      const out = await releaseHeldEarnings(tx, "e1", "review clean", "adm-1");

      expect(out).toEqual({ side: "consultant", status: to });
      expect(byId(store, "e1")).toMatchObject({
        status: to,
        preHoldStatus: null,
      });
      expect(store.holds[0]).toMatchObject({ releasedById: "adm-1" });
    },
  );

  it("a row with no recorded prior returns to PENDING even when matured, so the release job's guards decide READY", async () => {
    const { store, tx } = storeWith([
      earning("matured-row", HELD, { holdUntil: matured }),
      earning("waiting-row", HELD, { holdUntil: notYet }),
    ]);
    for (const id of ["matured-row", "waiting-row"]) {
      await placeEarningsHolds(store.db as never, "consultant", [id], {
        reason: EarningsHoldReason.OPERATOR,
        sourceRef: "seed",
      });
    }

    await releaseHeldEarnings(tx, "matured-row", "lifted", "adm-1");
    await releaseHeldEarnings(tx, "waiting-row", "lifted", "adm-1");

    expect(store.consultant.map((s) => s.status)).toEqual([
      EarningStatus.PENDING,
      EarningStatus.PENDING,
    ]);
  });
});
