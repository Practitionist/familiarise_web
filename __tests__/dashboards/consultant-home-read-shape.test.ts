/**
 * @jest-environment node
 */

/**
 * Pins the consultant-Home read regressions that produce quietly-wrong
 * numbers rather than errors: the slot-time ranking anchored at the
 * consultant's own today, the empty-id guard on the display read, and the
 * Available tile from one grouped earnings read.
 */

import prisma from "@/lib/prisma";
import { getConsultantDashboard } from "@/lib/data/consultant-dashboard";
import { consultantHomeStatus } from "@/lib/appointments/map-consultant";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: { findUnique: jest.fn() },
    appointmentOccurrence: { findMany: jest.fn(), count: jest.fn() },
    appointment: { findMany: jest.fn() },
    consultation: { count: jest.fn() },
    subscription: { count: jest.fn() },
    trial: { count: jest.fn() },
    consultantEarnings: { count: jest.fn(), groupBy: jest.fn() },
    rescheduleRequest: { findMany: jest.fn() },
    appointmentDocument: { count: jest.fn() },
    bookingStatusHistory: { findMany: jest.fn() },
    collaborator: { count: jest.fn() },
    consultantReview: { count: jest.fn() },
  },
}));

const m = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const slotFindMany = m.appointmentOccurrence.findMany;
const apptFindMany = m.appointment.findMany;

// 2026-10-31 20:00 UTC is already 1 Nov 01:30 in Kolkata.
const NOW = new Date("2026-10-31T20:00:00Z");

describe("consultant Home read shape", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    m.consultantProfile.findUnique.mockResolvedValue({
      publishedRatingOneToOne: 4.8,
      publishedRatingGroup: null,
      ratedClientsOneToOne: 12,
      ratedEventsGroup: 0,
      description: null,
      headline: null,
      experience: null,
      verificationStatus: "PENDING_VERIFICATION",
      scheduleType: "WEEKLY",
      taxInfo: null,
      payoutAccounts: [],
      _count: {
        subDomains: 0,
        tags: 0,
        availabilityWindowsWeekly: 0,
        availabilityWindowsCustom: 0,
        consultationPlans: 0,
        subscriptionPlans: 0,
        webinarPlans: 0,
        classPlans: 0,
        digitalProducts: 0,
      },
      user: {
        timezone: "Asia/Kolkata",
        image: null,
        profileDisplayImage: null,
        _count: { workExperiences: 0 },
      },
    });
    m.collaborator.count.mockResolvedValue(0);
    m.consultantReview.count.mockResolvedValue(0);
    slotFindMany.mockResolvedValue([]);
    apptFindMany.mockResolvedValue([]);
    m.appointmentOccurrence.count.mockResolvedValue(0);
    for (const model of ["consultation", "subscription", "trial"]) {
      m[model].count.mockResolvedValue(0);
    }
    m.consultantEarnings.count.mockResolvedValue(0);
    m.consultantEarnings.groupBy.mockResolvedValue([]);
    m.rescheduleRequest.findMany.mockResolvedValue([]);
    m.appointmentDocument.count.mockResolvedValue(0);
    m.bookingStatusHistory.findMany.mockResolvedValue([]);
  });

  it("ranks Home appointments by slot time, anchored at the consultant's start of today", async () => {
    await getConsultantDashboard("cp-1", NOW);

    // The ranking read (plans no org hosts), then the org-sessions strip
    // (org-hosted plans), labelled with the host org.
    const [args] = slotFindMany.mock.calls[0];
    const [orgArgs] = slotFindMany.mock.calls[1];
    expect(JSON.stringify(args.where.appointment)).toContain(
      '"consultationPlan":{"consultantProfileId":"cp-1","organizationId":null}',
    );
    expect(JSON.stringify(orgArgs.where.appointment)).toContain(
      '"consultationPlan":{"consultantProfileId":"cp-1","organizationId":{"not":null},"organization":{"is":{"status"',
    );
    expect(
      orgArgs.select.appointment.select.consultation.select.consultationPlan,
    ).toEqual({
      select: { organization: { select: { id: true, name: true } } },
    });

    // Ordering keys off the slot clock, never createdAt.
    expect(args.orderBy).toEqual({ startsAt: "asc" });
    // Anchored at midnight 1 Nov in Kolkata, so a session running today survives.
    expect(args.where.endsAt.gte).toEqual(new Date("2026-10-31T18:30:00Z"));
    expect(args.where.startsAt).toBeUndefined();
    expect(args.where.deletedAt).toBeNull();
  });

  it("issues no display read at all when there is nothing upcoming", async () => {
    await getConsultantDashboard("cp-1", NOW);
    expect(apptFindMany).not.toHaveBeenCalled();
  });

  it("still issues the display read when there IS something upcoming", async () => {
    slotFindMany.mockImplementation((args: { select: { id?: boolean } }) =>
      Promise.resolve(args.select.id ? [] : [{ appointmentId: "appt-1" }]),
    );

    await getConsultantDashboard("cp-1", NOW);

    expect(apptFindMany).toHaveBeenCalledTimes(1);
    const [display] = apptFindMany.mock.calls[0];
    expect(display.where.id.in).toEqual(["appt-1"]);
    expect(display.relationLoadStrategy).toBe("join");
  });

  it("carries the open move, so a booking being moved reads Being moved on Home", async () => {
    slotFindMany.mockImplementation((args: { select: { id?: boolean } }) =>
      Promise.resolve(args.select.id ? [] : [{ appointmentId: "appt-1" }]),
    );
    const move = {
      id: "rr-1",
      status: "PENDING_REVIEW",
      reason: null,
      // Live against the real clock: a lapsed move is no longer open.
      expiresAt: new Date(Date.now() + 2 * 86_400_000),
      initiatorRole: "CONSULTEE",
      initiatedById: "u-learner",
      proposedTimes: [
        {
          startsAt: new Date("2026-11-03T10:00:00Z"),
          endsAt: new Date("2026-11-03T11:00:00Z"),
        },
      ],
    };
    apptFindMany.mockResolvedValue([
      {
        id: "appt-1",
        appointmentType: "CONSULTATION",
        organizationId: null,
        occurrences: [],
        consultation: {
          id: "c-1",
          status: "PENDING",
          consultationPlan: {
            id: "p-1",
            title: "Call",
            consultantProfile: null,
          },
          requestedBy: { id: "ce-1", user: { name: "Lee", image: null } },
        },
        subscription: null,
        webinar: null,
        class: null,
        trial: null,
        rescheduleRequests: [move],
      },
    ]);

    const { appointments } = await getConsultantDashboard("cp-1", NOW);

    const [display] = apptFindMany.mock.calls[0];
    expect(display.select.rescheduleRequests.select).toMatchObject({
      initiatorRole: true,
      initiatedById: true,
      expiresAt: true,
    });
    expect(consultantHomeStatus(appointments[0]).label).toBe("Being moved");
  });

  it("derives Available from one grouped earnings read of READY and BATCHED", async () => {
    const group = (status: string, share: bigint, refunded: bigint) => ({
      status,
      _sum: { consultantSharePaise: share, refundedShareAmount: refunded },
    });
    m.consultantEarnings.groupBy.mockResolvedValue([
      group("READY", BigInt(50_000), BigInt(5_000)),
      group("BATCHED", BigInt(20_000), BigInt(0)),
    ]);

    const { financialSummary, performanceSnapshot } =
      await getConsultantDashboard("cp-1", NOW);

    expect(financialSummary).toEqual({ availableEarnings: 65_000 });
    expect(m.consultantEarnings.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["status"],
        where: {
          consultantProfileId: "cp-1",
          status: { in: ["READY", "BATCHED"] },
        },
      }),
    );
    expect(performanceSnapshot).toEqual({
      publishedRatingOneToOne: 4.8,
      publishedRatingGroup: null,
      ratedClientsOneToOne: 12,
      ratedEventsGroup: 0,
    });
  });

  it("derives the setup checklist from the one profile read, not extra reads", async () => {
    const { firstRun } = await getConsultantDashboard("cp-1", NOW);

    expect(m.consultantProfile.findUnique).toHaveBeenCalledTimes(1);
    expect(firstRun?.steps.map((step) => step.key)).toEqual([
      "verify",
      "profile",
      "hours",
      "offering",
      "payout",
    ]);
    expect(firstRun?.steps.some((step) => step.done)).toBe(false);
  });
});
