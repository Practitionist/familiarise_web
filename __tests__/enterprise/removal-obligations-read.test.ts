/**
 * @jest-environment node
 */

/**
 * #1854 — the Remove dialog's obligations read and the removal guard share
 * `countRemovalObligations`. A learner with a CONFIRMED seat on an upcoming
 * session this org paid for is listed before the confirm, and the guard
 * refuses a non-forced removal on the same count.
 */

import {
  assertRemovable,
  countRemovalObligations,
  type GuardedMembership,
} from "@/lib/enterprise/membership-guards";
import { describeRemovalObligations } from "@/lib/enterprise/removal-obligations";

const member: GuardedMembership = {
  id: "m-olivia",
  organizationId: "org-wipro",
  userId: "u-olivia",
  role: "LEARNER",
  status: "ACTIVE",
  consultantProfileId: null,
};

// Counts 1 only for a live CONSULTEE seat stamped with this org.
const occurrenceCount = jest.fn(async ({ where }) => {
  const seat = where.appointment?.participants?.some;
  return seat?.organizationId === "org-wipro" &&
    seat.userId === "u-olivia" &&
    seat.status.in.includes("CONFIRMED") &&
    where.startsAt.gt instanceof Date
    ? 1
    : 0;
});
const zero = { count: jest.fn(async () => 0) };
const tx = {
  appointmentOccurrence: { count: occurrenceCount },
  programAssignment: zero,
  overageEvent: zero,
  consultantEarnings: zero,
  refund: zero,
  dispute: zero,
  membership: zero,
} as unknown as Parameters<typeof assertRemovable>[0];

it("lists an upcoming org-funded session and blocks a non-forced removal", async () => {
  const now = new Date();
  const counts = await countRemovalObligations(tx, member, now);
  expect(describeRemovalObligations(counts)).toEqual([
    { key: "upcomingSessions", count: 1, label: "1 upcoming session" },
  ]);
  await expect(
    assertRemovable(tx, {
      membership: member,
      actor: { kind: "member", membershipId: "m-maint", role: "MAINTAINER" },
      force: false,
      now,
    }),
  ).rejects.toMatchObject({
    code: "MEMBER_HAS_OBLIGATIONS",
    counts: expect.objectContaining({ upcomingSessions: 1 }),
  });
});
