/**
 * @jest-environment node
 */

/**
 * Each reviewable session says whether the expert's public profile is served,
 * by the profile page's gate, without sending the verification status itself.
 */

const findMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findMany: (...a: unknown[]) => findMany(...a) },
    membership: { findMany: jest.fn(async () => []) },
    consultantReview: { findMany: jest.fn(async () => []) },
  },
}));

import { listReviewableSessions } from "@/lib/reviews";

const consultation = (
  id: string,
  verificationStatus: string,
  deletedAt: Date | null,
) => ({
  id,
  appointmentType: "CONSULTATION",
  webinarId: null,
  classId: null,
  organizationId: null,
  consultation: {
    consultationPlan: {
      title: "Career consultation",
      consultantProfileId: `cp_${id}`,
      consultantProfile: {
        verificationStatus,
        deletedAt,
        user: { name: `Expert ${id}` },
      },
    },
  },
  subscription: null,
  trial: null,
  webinar: null,
  class: null,
  occurrences: [{ endsAt: new Date("2026-11-10T06:30:00.000Z") }],
});

it("marks only a VERIFIED, live profile as public, and ships no status", async () => {
  findMany.mockResolvedValue([
    consultation("pending", "PENDING_VERIFICATION", null),
    consultation("verified", "VERIFIED", null),
    consultation("deleted", "VERIFIED", new Date("2026-11-19T00:00:00.000Z")),
  ]);

  const sessions = await listReviewableSessions("ce_daniel", "u_daniel");

  expect(sessions.map((s) => [s.appointmentId, s.profileIsPublic])).toEqual([
    ["pending", false],
    ["verified", true],
    ["deleted", false],
  ]);
  expect(JSON.stringify(sessions)).not.toMatch(
    /verificationStatus|PENDING_VERIFICATION|deletedAt/,
  );
  const select = findMany.mock.calls[0][0].select;
  for (const profile of [
    select.consultation.select.consultationPlan.select.consultantProfile,
    select.subscription.select.subscriptionPlan.select.consultantProfile,
    select.trial.select.consultantProfile,
    select.webinar.select.webinarPlan.select.consultantProfile,
    select.class.select.classPlan.select.consultantProfile,
  ]) {
    expect(profile.select).toMatchObject({
      verificationStatus: true,
      deletedAt: true,
    });
  }
});
