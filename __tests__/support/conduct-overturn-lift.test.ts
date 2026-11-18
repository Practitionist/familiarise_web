/**
 * @jest-environment node
 */

/**
 * An overturn lifts the mark its own conduct removal set, and never a later
 * plain removal: once a lift has followed the removal case, the seat's mark is
 * someone else's.
 */

const mockPersistBlock = jest.fn(async () => new Date());
jest.mock("../../lib/stream/access-revocation", () => ({
  persistConductBlockInTx: () => mockPersistBlock(),
  persistSeatRevocationInTx: jest.fn(),
  syncConductCallBlock: jest.fn(),
  revokeEndedSeatAccess: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import type { Tx } from "@/lib/prisma";
import {
  conductRemovalDecidedTx,
  removalRejoinPathTx,
} from "@/lib/support/conduct-removal-case";

const CASE_AT = new Date("2026-11-14T10:00:00Z");
const removalCase = {
  id: "case-1",
  category: "CONDUCT_REMOVAL",
  appealOfDecisionId: null,
};

function txWith(liftedSinceCase: boolean) {
  const cas = jest.fn(async () => ({ count: 1 }));
  const history = jest.fn(async () => ({ count: 1 }));
  const tx = {
    supportCase: {
      findUniqueOrThrow: async () => ({
        appointmentId: "appt-1",
        requesterUserId: "u-1",
        createdAt: CASE_AT,
      }),
    },
    appointmentParticipant: {
      findUnique: async () => ({ id: "part-1" }),
      findFirst: async () => ({
        id: "part-1",
        status: "CANCELLED",
        appointmentId: "appt-1",
        removedByUserId: "host-1",
        payment: null,
        appointment: { webinar: null, class: null },
      }),
      updateMany: cas,
    },
    bookingStatusHistory: {
      findFirst: async () => (liftedSinceCase ? { id: "lift-1" } : null),
      createMany: history,
    },
  } as unknown as Tx;
  return { tx, cas, history };
}

it("lifts the conduct removal's own mark on an overturn", async () => {
  const { tx, cas, history } = txWith(false);
  await conductRemovalDecidedTx(tx, removalCase, "OVERTURNED", "staff-1");
  expect(cas).toHaveBeenCalledWith({
    where: { id: "part-1", removedByUserId: { not: null } },
    data: { removedByUserId: null },
  });
  expect(history).toHaveBeenCalledTimes(1);
});

it("leaves a later plain removal's mark alone when a lift already followed the case", async () => {
  const { tx, cas, history } = txWith(true);
  await conductRemovalDecidedTx(tx, removalCase, "OVERTURNED", "staff-1");
  expect(cas).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
  // The unblock intent is still written: the drive reads the direction from Postgres.
  expect(mockPersistBlock).toHaveBeenCalled();
});

describe("what the overturn notice promises", () => {
  /** A free seat; `markedNow` is the seat's current mark, `liftedSinceCase` a lift after the case. */
  function noticeTx(opts: { liftedSinceCase: boolean; markedNow: boolean }) {
    return {
      supportCase: {
        findUniqueOrThrow: async () => ({
          appointmentId: "appt-1",
          requesterUserId: "u-1",
          createdAt: CASE_AT,
        }),
      },
      appointmentParticipant: {
        findUnique: async () => ({
          id: "part-1",
          removedByUserId: opts.markedNow ? "host-1" : null,
          payment: { paymentIntent: "free_1", amount: 0, originalAmount: 0 },
        }),
      },
      bookingStatusHistory: {
        findFirst: async () => (opts.liftedSinceCase ? { id: "lift-1" } : null),
      },
    } as unknown as Tx;
  }

  it("says a free seat can register again when the overturn lifts its only block", async () => {
    await expect(
      removalRejoinPathTx(
        noticeTx({ liftedSinceCase: false, markedNow: true }),
        removalCase,
      ),
    ).resolves.toBe("REGISTER");
  });

  it("points to support when a later removal still blocks the seat", async () => {
    await expect(
      removalRejoinPathTx(
        noticeTx({ liftedSinceCase: true, markedNow: true }),
        removalCase,
      ),
    ).resolves.toBe("SUPPORT");
  });
});
