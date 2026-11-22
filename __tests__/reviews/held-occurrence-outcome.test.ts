/**
 * @jest-environment node
 */

// A forfeit (LEARNER_ABSENT, COMPLETED) needs you in Stream's settled record of
// the call, and the no-attendance arm only admits sessions nobody could record.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { heldOccurrence } from "@/lib/reviews";

it("a LEARNER_ABSENT consultee is not eligible; an offline session is", () => {
  const [attended, unrecorded, beforeRollout] =
    heldOccurrence("consultee-1").OR;
  expect(attended).toEqual({
    meeting: { attendanceSettledAt: { not: null } },
    presences: { some: { userId: "consultee-1" } },
  });
  // The earlier rule stays, so a session it accepted before the rollout stays rateable.
  expect(beforeRollout).toEqual({
    AND: [
      { attendances: { some: { userId: "consultee-1" } } },
      {
        OR: [
          { meeting: { endedAt: { not: null } } },
          { endsAt: { lt: expect.any(Date) } },
        ],
      },
    ],
  });
  expect(unrecorded).toEqual({
    completionStatus: "UNVERIFIED",
    OR: [{ outcome: null }, { outcome: { in: ["OFFLINE", "INCONCLUSIVE"] } }],
  });
});
