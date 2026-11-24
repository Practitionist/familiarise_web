/**
 * @jest-environment node
 */

/**
 * A subscription's voids never hold its earnings: the plan's earnings release
 * per delivered tranche, and the money a void is owed is settled at plan end
 * or by the cancel quote, so an unsettled void holds the plan's completion
 * instead. Consultation, class and webinar misses still hold their earnings.
 * And once a plan has ended, ops cannot void one of its sessions, because
 * nothing would ever settle it.
 */
import fs from "node:fs";
import path from "node:path";

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: (_id: string, fn: () => unknown) => fn(),
}));

import { EARNINGS_HOLDING_MISS, UNSETTLED_MISS } from "@/lib/booking/misses";
import { RELEASABLE_PAYMENT } from "@/scripts/earnings/release-earnings";
import { setSessionOutcome } from "@/lib/backoffice/session-outcomes";
import type { Tx } from "@/lib/prisma";

describe("subscription misses do not hold earnings", () => {
  it("the earnings-holding miss is an unsettled miss off a subscription", () => {
    expect(EARNINGS_HOLDING_MISS).toEqual({
      ...UNSETTLED_MISS,
      appointment: { subscriptionId: null },
    });
  });

  it("release-earnings gates on the earnings-holding miss, not every miss", () => {
    expect(JSON.stringify(RELEASABLE_PAYMENT)).toContain(
      JSON.stringify({ none: EARNINGS_HOLDING_MISS }),
    );
    expect(JSON.stringify(RELEASABLE_PAYMENT)).not.toContain(
      JSON.stringify({ none: UNSETTLED_MISS }),
    );
  });

  it("subscription auto-complete waits for unsettled misses and undecided sessions, like the event arms", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "scripts/appointments/auto-complete-appointments.ts",
      ),
      "utf8",
    );
    const subscriptionArm = source.slice(
      source.indexOf("const subscriptionsToComplete"),
      source.indexOf(
        "include:",
        source.indexOf("const subscriptionsToComplete"),
      ),
    );
    expect(subscriptionArm).toContain("endedAndSettled(bufferTime)");
  });
});

describe("ops overturn to VOIDED on a plan", () => {
  const NOW = new Date("2026-06-01T00:00:00Z");
  const unstamp = jest.fn(async (_args: unknown) => ({ count: 1 }));
  // 4 sessions at 1 a week: the void leaves the second cycle undelivered.
  const session = (completionStatus: string, day: number) => ({
    startsAt: new Date(Date.UTC(2026, 4, day, 10)),
    endsAt: new Date(Date.UTC(2026, 4, day, 11)),
    completionStatus,
    isTentative: false,
    deletedAt: null,
  });
  function txFor(planStatus: string) {
    return {
      appointment: {
        findUnique: async () => ({
          payment: [{ id: "pay-1" }],
          subscription: {
            status: planStatus,
            sessionsTotal: 4,
            sessionsPerWeek: 1,
            sessionsRefunded: 0,
            schedulingPeriodStartsAt: new Date("2026-04-24T00:00:00Z"),
            schedulingTimezone: "UTC",
            planEndsAt: null,
            subscriptionPlan: {
              totalSessions: 4,
              sessionsPerWeek: 1,
              durationInMonths: 1,
            },
          },
          occurrences: [session("COMPLETED", 1), session("VOIDED", 8)],
        }),
      },
      consultantEarnings: { updateMany: unstamp },
      appointmentOccurrence: {
        findUnique: async () => ({
          id: "occ-1",
          appointmentId: "apt-1",
          ordinal: 3,
          startsAt: new Date("2026-05-01T10:00:00Z"),
          endsAt: new Date("2026-05-01T11:00:00Z"),
          completionStatus: "COMPLETED",
          outcome: "HELD",
          seatsSettledAt: null,
          deletedAt: null,
          isTentative: false,
          appointment: { classId: null, subscription: { status: planStatus } },
        }),
        findMany: async () => [],
        updateManyAndReturn: async () => [
          { id: "occ-1", appointmentId: "apt-1" },
        ],
      },
      bookingStatusHistory: { create: async () => ({}) },
    } as unknown as Tx;
  }

  it.each(["COMPLETED", "CANCELLED", "EXPIRED"])(
    "is refused once the plan is %s",
    async (status) => {
      await expect(
        setSessionOutcome(txFor(status), {
          occurrenceId: "occ-1",
          outcome: "PLATFORM_OUTAGE",
          actorUserId: "ops-1",
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: "PLAN_SETTLED" });
    },
  );

  it("un-stamps the tranche a live plan's voided session un-delivers", async () => {
    await setSessionOutcome(txFor("APPROVED"), {
      occurrenceId: "occ-1",
      outcome: "PLATFORM_OUTAGE",
      actorUserId: "ops-1",
      now: NOW,
    });
    expect(unstamp).toHaveBeenCalledWith({
      where: expect.objectContaining({
        paymentId: { in: ["pay-1"] },
        cycleOrdinal: { gt: 0 },
        holdUntil: { not: null },
      }),
      data: { holdUntil: null },
    });
  });
});
