/**
 * @jest-environment node
 */

/**
 * Rows the database should never hold, fed through every booking mapper the
 * dashboards render from: none may throw, an impossible session never reaches
 * a timeline, off-grid times survive, a booking with no live session says what
 * it needs, and a 10k-session series maps in linear time.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import { mapAppointmentDetail } from "@/lib/appointments/map-detail";
import {
  detailEntitlement,
  toPresentationInput,
} from "@/lib/appointments/presentation-input";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import type { TAppointment } from "@/types/appointment";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";

const NOW = new Date("2026-09-14T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const CONSULTANT = "cp-1";

function session(
  id: string,
  startsAt: Date,
  endsAt: Date | null,
  completionStatus = "SCHEDULED",
) {
  return {
    id,
    startsAt,
    endsAt,
    isTentative: false,
    completionStatus,
    deletedAt: null,
    meeting: null,
  };
}

const inFuture = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

// endsAt before startsAt, beside a real session that starts off the grid.
const inverted = session("inverted", inFuture(26), inFuture(25));
const offGrid = session(
  "off-grid",
  new Date(inFuture(48).getTime() + 17 * 60 * 1000),
  new Date(inFuture(49).getTime() + 17 * 60 * 1000),
);
const plan = {
  id: "plan-1",
  title: "Career call",
  consultantProfileId: CONSULTANT,
  consultantProfile: { id: CONSULTANT, user: { name: "Coach", image: null } },
};
const consultee = { user: { name: "Buyer", image: null } };

const bigClass = Array.from({ length: 10_000 }, (_, i) =>
  session(`class-${i}`, inFuture(i * 24), inFuture(i * 24 + 1)),
);

const consultantRows = [
  {
    id: "appt-inverted",
    appointmentType: "CONSULTATION",
    occurrences: [inverted, offGrid],
    consultation: {
      status: "APPROVED",
      consultationPlan: plan,
      requestedBy: consultee,
    },
  },
  // An orphan: the type says consultation, the relation is gone.
  {
    id: "appt-orphan",
    appointmentType: "CONSULTATION",
    occurrences: [],
    consultation: null,
  },
  {
    id: "appt-awaiting",
    appointmentType: "SUBSCRIPTION",
    subscriptionId: "sub-1",
    occurrences: [],
    subscription: {
      status: "APPROVED",
      subscriptionPlan: { ...plan, title: "Weekly coaching" },
      requestedBy: consultee,
    },
  },
  {
    id: "appt-lost",
    appointmentType: "CONSULTATION",
    occurrences: [session("gone", inFuture(5), inFuture(6), "CANCELLED")],
    consultation: {
      status: "APPROVED",
      consultationPlan: plan,
      requestedBy: consultee,
    },
  },
  {
    id: "appt-class",
    appointmentType: "CLASS",
    classId: "class-1",
    occurrences: bigClass,
    class: {
      status: "SCHEDULED",
      classPlan: { ...plan, title: "Cohort", collaborators: [] },
    },
  },
] as unknown as TAppointment[];

describe("consultant list mapper", () => {
  it("maps impossible rows without throwing and draws only real sessions", () => {
    const t0 = Date.now();
    const vms = mapConsultantAppointments(
      { appointments: consultantRows, consultantId: CONSULTANT },
      NOW,
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
    const byId = new Map(vms.map((vm) => [vm.appointmentId ?? vm.id, vm]));

    const mixed = byId.get("appt-inverted");
    expect(mixed?.occurrences.map((o) => o.occurrenceId)).toEqual(["off-grid"]);
    expect(mixed?.nextAt).toEqual(offGrid.startsAt);

    expect(byId.get("appt-orphan")).toBeDefined();
    expect(byId.get("appt-awaiting")?.needsActionReason).toBe(
      "AWAITING_SCHEDULING",
    );
    expect(byId.get("appt-lost")?.needsActionReason).toBe("NEEDS_RESCHEDULING");

    const cohort = vms.find((vm) => vm.kind === "CLASS");
    expect(cohort?.occurrences).toHaveLength(10_000);
    expect(cohort?.nextAt).toEqual(bigClass[0].startsAt);
  });
});

describe("consultee list mapper", () => {
  it("maps impossible rows without throwing", () => {
    const data = {
      consultations: [
        {
          id: "c-1",
          status: "APPROVED",
          consultationPlan: plan,
          appointment: { id: "appt-c1", occurrences: [inverted, offGrid] },
        },
      ],
      subscriptions: [
        {
          id: "s-1",
          status: "APPROVED",
          subscriptionPlan: { ...plan, title: "Weekly coaching" },
          appointment: null,
        },
      ],
      webinars: [],
      classes: [],
      trials: [],
    } as unknown as TConsulteeEventsResponse;

    const [consultation, subscription] = mapConsulteeEvents(data, NOW);
    expect(consultation.occurrences.map((o) => o.occurrenceId)).toEqual([
      "off-grid",
    ]);
    expect(consultation.raw.rawOccurrences?.map((o) => o.id)).toEqual([
      "off-grid",
    ]);
    expect(subscription.needsActionReason).toBe("AWAITING_SCHEDULING");
    expect(subscription.occurrences).toEqual([]);
  });
});

function detailOf(appointment: Record<string, unknown>): TAppointmentDetail {
  return {
    appointment: {
      organizationId: null,
      consultation: null,
      subscription: null,
      webinar: null,
      class: null,
      trial: null,
      payment: [],
      participants: [],
      statusHistory: [],
      rescheduleRequests: [],
      ...appointment,
    },
  } as unknown as TAppointmentDetail;
}

describe("detail mapper and presentation input", () => {
  const names = { payer: "Buyer", consultant: "Coach" };

  it("an approved consultation that lost its session says so and never throws", () => {
    const detail = detailOf({
      id: "appt-lost",
      appointmentType: "CONSULTATION",
      occurrences: [session("gone", inFuture(5), inFuture(6), "CANCELLED")],
      consultation: {
        status: "APPROVED",
        requestedAt: NOW,
        pendingPaymentUrl: null,
        consultationPlan: { ...plan, price: 100_000, priceCurrency: "INR" },
        requestedBy: consultee,
      },
    });
    const { vm } = mapAppointmentDetail(detail, "consultee", NOW);
    expect(vm.needsActionReason).toBe("NEEDS_RESCHEDULING");
    expect(() =>
      toPresentationInput(detail, {
        viewerId: null,
        names,
        sponsorOrgName: null,
      }),
    ).not.toThrow();
  });

  it("drops an inverted session from the timeline, the hooks and the derivation", () => {
    const detail = detailOf({
      id: "appt-inverted",
      appointmentType: "CONSULTATION",
      occurrences: [inverted, offGrid],
      consultation: {
        status: "APPROVED",
        requestedAt: NOW,
        pendingPaymentUrl: null,
        consultationPlan: { ...plan, price: 100_000, priceCurrency: "INR" },
        requestedBy: consultee,
      },
    });
    const { vm } = mapAppointmentDetail(detail, "consultant", NOW);
    expect(vm.occurrences.map((o) => o.occurrenceId)).toEqual(["off-grid"]);
    expect(vm.raw.rawOccurrences?.map((o) => o.id)).toEqual(["off-grid"]);
    const input = toPresentationInput(detail, {
      viewerId: null,
      names,
      sponsorOrgName: null,
    });
    expect(input.occurrences.map((o) => o.startsAt)).toEqual([
      offGrid.startsAt,
    ]);
  });

  it("a subscription with no plan and no sessions maps to a placeholder", () => {
    const detail = detailOf({
      id: "appt-planless",
      appointmentType: "SUBSCRIPTION",
      occurrences: [],
      subscription: {
        status: "APPROVED",
        requestedAt: NOW,
        pendingPaymentUrl: null,
        subscriptionPlan: null,
        requestedBy: consultee,
      },
    });
    const { vm } = mapAppointmentDetail(detail, "consultee", NOW);
    expect(vm.title).toBe("Subscription");
    expect(vm.needsActionReason).toBe("AWAITING_SCHEDULING");
    expect(detailEntitlement(detail.appointment, NOW)).toBeNull();
    const input = toPresentationInput(detail, {
      viewerId: null,
      names,
      sponsorOrgName: null,
    });
    expect(input.plan).toBeNull();
  });

  it("an orphan wrapper (type set, relation gone) still maps", () => {
    const detail = detailOf({
      id: "appt-orphan",
      appointmentType: "SUBSCRIPTION",
      occurrences: [],
    });
    expect(() => mapAppointmentDetail(detail, "consultant", NOW)).not.toThrow();
    expect(() =>
      toPresentationInput(detail, {
        viewerId: null,
        names,
        sponsorOrgName: null,
      }),
    ).not.toThrow();
  });

  it("a 10k-session class maps in linear time", () => {
    const detail = detailOf({
      id: "appt-class",
      appointmentType: "CLASS",
      occurrences: bigClass.map((o, i) => ({ ...o, ordinal: i + 1 })),
      class: {
        status: "SCHEDULED",
        classPlan: {
          ...plan,
          title: "Cohort",
          totalSessions: 10_000,
          price: 0,
          priceCurrency: "INR",
          collaborators: [],
        },
      },
    });
    const t0 = Date.now();
    const { vm } = mapAppointmentDetail(detail, "consultee", NOW);
    const input = toPresentationInput(detail, {
      viewerId: null,
      names,
      sponsorOrgName: null,
    });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(vm.occurrences).toHaveLength(10_000);
    expect(input.series?.N).toBe(10_000);
  });
});
