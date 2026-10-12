/**
 * @jest-environment node
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  mapAppointmentDetail,
  recordingSessionLabel,
} from "@/lib/appointments/map-detail";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function slot(
  id: string,
  ordinal: number,
  daysFromNow: number,
  recordings: { id: string; minute: number }[] = [],
  completionStatus = daysFromNow < 0 ? "COMPLETED" : "SCHEDULED",
) {
  const startsAt = new Date(NOW.getTime() + daysFromNow * DAY);
  return {
    id,
    ordinal,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    isTentative: false,
    completionStatus,
    deletedAt: null,
    meeting: {
      id: `m-${id}`,
      endedAt: null,
      endedReason: null,
      recordings: recordings.map((r) => ({
        id: r.id,
        title: r.id,
        thumbnailUrl: null,
        status: "READY",
        durationInMinutes: 30,
        recordedAt: new Date(startsAt.getTime() + r.minute * 60 * 1000),
      })),
    },
  };
}

function detail(occurrences: ReturnType<typeof slot>[]): TAppointmentDetail {
  return {
    appointment: {
      id: "appt-sub",
      appointmentType: "SUBSCRIPTION",
      organizationId: null,
      consultation: null,
      webinar: null,
      class: null,
      trial: null,
      subscription: {
        status: "SCHEDULED",
        pendingPaymentUrl: null,
        subscriptionPlan: {
          title: "Weekly coaching",
          consultantProfile: {
            id: "cp-1",
            user: { name: "Coach", image: null },
          },
        },
        requestedBy: { user: { name: "Buyer", image: null } },
      },
      payment: [],
      participants: [],
      occurrences,
    },
  } as unknown as TAppointmentDetail;
}

const labels = (d: TAppointmentDetail) =>
  Object.fromEntries(
    mapAppointmentDetail(d, "consultee", NOW).recordings.map((r) => [
      r.id,
      recordingSessionLabel(r),
    ]),
  );

it("numbers past recordings by ordinal while later sessions are still upcoming", () => {
  expect(
    labels(
      detail([
        slot("s1", 1, -14, [{ id: "r1", minute: 0 }]),
        slot("s2-old", 2, -9, [], "RESCHEDULED"),
        slot("s2", 2, -7, [{ id: "r2", minute: 0 }]),
        slot("s3", 3, -1, [
          { id: "r3-b", minute: 40 },
          { id: "r3-a", minute: 5 },
        ]),
        slot("s4", 4, 6),
        slot("s5", 5, 13),
      ]),
    ),
  ).toEqual({
    r1: "Session 1",
    r2: "Session 2",
    "r3-a": "Session 3 · Part 1 of 2",
    "r3-b": "Session 3 · Part 2 of 2",
  });
});

it("keeps the labels once the whole programme is over", () => {
  expect(
    labels(
      detail([
        slot("s1", 1, -21, [{ id: "r1", minute: 0 }]),
        slot("s2", 2, -14, [{ id: "r2", minute: 0 }]),
      ]),
    ),
  ).toEqual({ r1: "Session 1", r2: "Session 2" });
});

it("gives a single-session booking no session number", () => {
  expect(
    labels(detail([slot("s1", 1, -1, [{ id: "r1", minute: 0 }])])),
  ).toEqual({ r1: null });
});
