/**
 * @jest-environment node
 */

// #1569 A-10 — ops may un-void a session only while nothing was paid for it.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/booking/class-sessions", () => ({
  onClassSessionVoided: jest.fn(),
  // No make-up was offered for these sessions.
  cancelUnstartedMakeUp: jest.fn(async () => ({ cancelled: false, bells: [] })),
}));
const stageNotices = jest.fn(async (..._a: unknown[]) => ({
  bells: [],
  emails: [],
}));
jest.mock("../../lib/booking/outcome-notices", () => ({
  prepareReviewedOutcomeNotices: jest.fn(),
  stageOutcomeNotices: (...a: unknown[]) => stageNotices(...a),
}));

// An operator's expert absent on a live paid consultation runs the no-show claim.
const claimNoShow = jest.fn(async (..._a: unknown[]) => ({ held: null }));
const settleClaim = jest.fn(async (..._a: unknown[]) => ({ refunded: true }));
jest.mock("../../lib/booking/consultant-no-show", () => ({
  ...jest.requireActual("../../lib/booking/consultant-no-show"),
  readOperatorNoShowClaim: jest.fn(async () => ({
    claim: { consultationId: "cons-1" },
  })),
  claimNoShowTx: (...a: unknown[]) => claimNoShow(...a),
  settleClaimedNoShow: (...a: unknown[]) => settleClaim(...a),
}));
const flushNotices = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...a: unknown[]) => flushNotices(...a),
}));

import { setSessionOutcome } from "@/lib/backoffice/session-outcomes";
import type { Tx } from "@/lib/prisma";

const voidedTx = (refund: { id: string } | null) =>
  ({
    appointmentOccurrence: {
      findUnique: async () => ({
        id: "occ-1",
        appointmentId: "apt-1",
        ordinal: 3,
        startsAt: new Date("2026-09-01T10:00:00Z"),
        endsAt: new Date("2026-09-01T11:00:00Z"),
        completionStatus: "VOIDED",
        outcome: "CUT_SHORT",
        seatsSettledAt: null,
        deletedAt: null,
        isTentative: false,
        appointment: { classId: "cls-1" },
      }),
      findFirst: async () => null,
    },
    refund: { findFirst: async () => refund },
  }) as unknown as Tx;

beforeEach(() => jest.clearAllMocks());

it("refuses to overturn a void once an occ: refund exists (409)", async () => {
  const tx = voidedTx({ id: "rf-1" });
  await expect(
    setSessionOutcome(tx, {
      occurrenceId: "occ-1",
      outcome: "HELD",
      actorUserId: "ops-1",
    }),
  ).rejects.toMatchObject({ code: "OUTCOME_SETTLED", httpStatus: 409 });
});

// #1834 — VOIDED → UNVERIFIED is not in the transition map, so the door refuses it.
it("refuses an outcome whose status move the transition map forbids", async () => {
  await expect(
    setSessionOutcome(voidedTx(null), {
      occurrenceId: "occ-1",
      outcome: "INCONCLUSIVE",
      actorUserId: "ops-1",
    }),
  ).rejects.toMatchObject({ code: "TRANSITION_NOT_ALLOWED", httpStatus: 409 });
});

const completedTx = (outcome: "LEARNER_ABSENT" | "HELD") =>
  ({
    appointmentOccurrence: {
      findUnique: async () => ({
        id: "occ-1",
        appointmentId: "apt-1",
        ordinal: 1,
        startsAt: new Date("2026-09-01T10:00:00Z"),
        endsAt: new Date("2026-09-01T11:00:00Z"),
        completionStatus: "COMPLETED",
        outcome,
        seatsSettledAt: null,
        deletedAt: null,
        isTentative: false,
        appointment: { classId: null, subscription: null },
      }),
      updateMany: async () => ({ count: 1 }),
    },
  }) as unknown as Tx;

const notices = { entityRef: "appointment:apt-1", bells: [], emails: null };

it.each([
  ["a negative verdict ops overturn", "LEARNER_ABSENT", "LEARNER_ABSENT", 1],
  [
    "a verdict that changed since the notice was rendered",
    "HELD",
    "LEARNER_ABSENT",
    0,
  ],
  ["a non-negative verdict", "HELD", "HELD", 0],
] as const)(
  "%s stages the reviewed notice %i time(s), in the overturn's transaction",
  async (_label, stored, renderedFrom, times) => {
    const tx = completedTx(stored);
    await setSessionOutcome(tx, {
      occurrenceId: "occ-1",
      outcome:
        stored === renderedFrom && stored === "HELD"
          ? "LEARNER_ABSENT"
          : "HELD",
      actorUserId: "ops-1",
      review: { from: renderedFrom, notices: notices as never },
    });
    expect(stageNotices.mock.calls).toEqual(
      Array.from({ length: times }, () => [tx, notices]),
    );
  },
);

it("an expert absent that runs the no-show claim stages the reviewed notice with the claim, and sends it after the claim's own refund drive", async () => {
  // A parked consultation session whose learner absence both sides were told of.
  const tx = {
    appointmentOccurrence: {
      findUnique: async () => ({
        id: "occ-1",
        appointmentId: "apt-1",
        ordinal: 1,
        startsAt: new Date("2026-09-01T10:00:00Z"),
        endsAt: new Date("2026-09-01T11:00:00Z"),
        completionStatus: "UNVERIFIED",
        outcome: "LEARNER_ABSENT",
        outcomeConfirmedAt: null,
        seatsSettledAt: null,
        deletedAt: null,
        isTentative: false,
        appointment: {
          classId: null,
          organizationId: null,
          subscription: null,
          consultation: { consultationPlan: { consultantProfileId: "cp-1" } },
        },
      }),
      updateMany: async () => ({ count: 1 }),
    },
  } as unknown as Tx;

  const result = await setSessionOutcome(tx, {
    occurrenceId: "occ-1",
    outcome: "HOST_ABSENT",
    actorUserId: "ops-1",
    review: { from: "LEARNER_ABSENT", notices: notices as never },
  });

  expect(claimNoShow).toHaveBeenCalledTimes(1);
  expect(stageNotices.mock.calls).toEqual([[tx, notices]]);
  expect(flushNotices).not.toHaveBeenCalled();
  await result.afterCommit?.();
  expect(settleClaim).toHaveBeenCalledTimes(1);
  expect(flushNotices).toHaveBeenCalledWith(
    {
      bells: [],
      emails: [{ rows: [], emailType: "SESSION_OUTCOME_REVIEWED" }],
    },
    "session.set-outcome",
  );
  expect(settleClaim.mock.invocationCallOrder[0]).toBeLessThan(
    flushNotices.mock.invocationCallOrder[0],
  );
});
