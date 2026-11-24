/**
 * @jest-environment node
 */

/**
 * `isProvider` is the host identity reports are judged by (`sessionHostUserIds`):
 * the plan's owner, every ACCEPTED collaborator, and a paid trial's expert. The
 * report itself follows the ended session the page names.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    recording: { findFirst: jest.fn(async () => null) },
    membership: { findFirst: jest.fn(async () => null) },
    // #1852 — the support context reads the caller's seat org on a webinar.
    appointmentParticipant: { findUnique: jest.fn(async () => null) },
  },
}));

import prisma from "@/lib/prisma";
import { buildSupportContext } from "@/lib/support/context";
import { flowsForContext } from "@/lib/support/flows";

const mockPrisma = prisma as unknown as {
  appointment: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
};

const PAST_START = new Date(Date.now() - 3 * 3_600_000);
const PAST_END = new Date(PAST_START.getTime() + 60 * 60_000);

beforeEach(() => {
  mockPrisma.appointment.findUnique.mockResolvedValue({
    id: "appt1",
    appointmentType: "WEBINAR",
    organizationId: null,
    cancellationPolicy: null,
    occurrences: [
      {
        id: "slot-a",
        startsAt: PAST_START,
        endsAt: PAST_END,
        isTentative: false,
        completionStatus: "COMPLETED",
      },
    ],
    payment: [],
    consultation: null,
    subscription: null,
    trial: null,
    webinar: {
      webinarPlan: {
        title: "W",
        consultantProfile: { userId: "u-owner" },
        collaborators: [{ consultantProfile: { userId: "u-cohost" } }],
      },
    },
    class: null,
  });
});

it("treats an ACCEPTED collaborator as a provider and withholds the attendee NO_SHOW flow", async () => {
  const ctx = await buildSupportContext("t1", "appt1", "u-cohost", "NO_SHOW");
  expect(ctx?.isProvider).toBe(true);

  const noShow = flowsForContext(ctx!).filter((f) => f.category === "NO_SHOW");
  expect(noShow.map((f) => f.title)).toEqual(["The participant didn't join"]);
});

it("reads only ACCEPTED collaborators whose profile is not soft-deleted", async () => {
  await buildSupportContext("t1", "appt1", "u-cohost", "NO_SHOW");
  const select = mockPrisma.appointment.findUnique.mock.calls[0][0].select;
  const expected = {
    status: "ACCEPTED",
    consultantProfile: { deletedAt: null },
  };
  expect(select.webinar.select.webinarPlan.select.collaborators.where).toEqual(
    expected,
  );
  expect(select.class.select.classPlan.select.collaborators.where).toEqual(
    expected,
  );
});

const reasonsOffered = (
  ctx: NonNullable<Awaited<ReturnType<typeof buildSupportContext>>>,
) =>
  flowsForContext(ctx)
    .filter((f) => f.category === "NO_SHOW")
    .flatMap((f) =>
      Object.values(f.nodes).flatMap((n) =>
        n.kind === "TERMINAL" && n.reason ? [n.reason] : [],
      ),
    );

it("gives a paid trial's expert the host flow, so 'I was there' is the host's dispute", async () => {
  mockPrisma.appointment.findUnique.mockResolvedValueOnce({
    ...(await mockPrisma.appointment.findUnique.getMockImplementation()?.()),
    appointmentType: "SUBSCRIPTION",
    webinar: null,
    trial: {
      subscriptionPlan: { consultantProfile: { userId: "u-trial-expert" } },
    },
  });
  const ctx = await buildSupportContext(
    "t1",
    "appt1",
    "u-trial-expert",
    "NO_SHOW",
  );
  expect(ctx?.isProvider).toBe(true);
  expect(reasonsOffered(ctx!)).toContain("provider_attended");
  expect(reasonsOffered(ctx!)).not.toContain("attendee_attended");
});

it("offers the report for the ended session the page names while upcoming actions keep the next session", async () => {
  const future = new Date(Date.now() + 24 * 3_600_000);
  mockPrisma.appointment.findUnique.mockResolvedValue({
    ...(await mockPrisma.appointment.findUnique.getMockImplementation()?.()),
    appointmentType: "SUBSCRIPTION",
    webinar: null,
    subscription: {
      subscriptionPlan: { title: "S", consultantProfile: { userId: "u-host" } },
    },
    occurrences: [
      {
        id: "slot-a",
        startsAt: PAST_START,
        endsAt: PAST_END,
        isTentative: false,
        completionStatus: "COMPLETED",
      },
      {
        id: "slot-b",
        startsAt: future,
        endsAt: new Date(future.getTime() + 3_600_000),
        isTentative: false,
        completionStatus: "SCHEDULED",
      },
    ],
  });
  const onA = await buildSupportContext(
    "t1",
    "appt1",
    "u-learner",
    undefined,
    "slot-a",
  );
  expect(onA).toMatchObject({
    stage: "UPCOMING",
    reportOccurrenceId: "slot-a",
  });
  expect(onA!.reportSessions.map((r) => r.id)).toEqual(["slot-a"]);
  expect(reasonsOffered(onA!)).toContain("attendee_attended");

  // The future session cannot be reported on, so its page offers no report.
  const onB = await buildSupportContext(
    "t1",
    "appt1",
    "u-learner",
    undefined,
    "slot-b",
  );
  expect(onB!.reportSessions).toEqual([]);
  expect(reasonsOffered(onB!)).toEqual([]);
});
