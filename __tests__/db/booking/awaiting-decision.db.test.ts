/**
 * A session parked for ops (`AWAITING_HUMAN`) holds its booking, on real Postgres:
 *  - auto-complete's final CAS on each of the five kinds refuses a booking whose
 *    session was parked after the cohort read;
 *  - a stored COMPLETED booking with a parked session reads "Waiting on a
 *    decision" through every list and detail reader, and a free one, whose
 *    no-join completes, still reads Completed.
 */
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedConsultee, seedHost, seedOneToOne } from "./harness";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () => ({
  __esModule: true,
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
// Another suite's past SCHEDULED session is left undecided rather than asked of Stream.
jest.mock("../../../lib/booking/session-outcome-sweep", () => ({
  ...jest.requireActual("../../../lib/booking/session-outcome-sweep"),
  decideSlotOutcome: jest.fn(async () => ({
    kind: "deferred",
    reason: "stream-budget",
  })),
  alertStaleNeedsHuman: jest.fn(async () => undefined),
}));

/** The booking whose session a concurrent writer parks just before its completing CAS. */
const mockPark: { entityId: string | null; occurrenceId: string | null } = {
  entityId: null,
  occurrenceId: null,
};
jest.mock("../../../lib/booking/transitions", () => {
  const actual = jest.requireActual("../../../lib/booking/transitions");
  type Helper = (
    tx: Prisma.TransactionClient,
    args: { where: { id: string } },
  ) => Promise<unknown>;
  const parkedFirst =
    (helper: Helper): Helper =>
    async (tx, args) => {
      if (mockPark.occurrenceId && mockPark.entityId === args.where.id) {
        await tx.appointmentOccurrence.update({
          where: { id: mockPark.occurrenceId },
          data: { completionStatus: "UNVERIFIED", outcome: "INCONCLUSIVE" },
        });
      }
      return helper(tx, args);
    };
  return {
    ...actual,
    transitionWebinarEvent: parkedFirst(actual.transitionWebinarEvent),
    transitionClassEvent: parkedFirst(actual.transitionClassEvent),
    transitionConsultationRequest: parkedFirst(
      actual.transitionConsultationRequest,
    ),
    transitionSubscriptionRequest: parkedFirst(
      actual.transitionSubscriptionRequest,
    ),
    transitionTrial: parkedFirst(actual.transitionTrial),
  };
});

import { autoCompleteAppointments } from "../../../scripts/appointments/auto-complete-appointments";
import { readConsulteeEvents } from "../../../lib/data/consultee-events-read";
import { readConsultantAppointmentsPage } from "../../../lib/data/consultant-appointments";
import {
  readAppointmentDetail,
  scopeAppointmentDetail,
} from "../../../lib/data/appointment-detail";
import { listAppointmentsScoped } from "../../../lib/api/scope/list-appointments";
import { getStaffAppointments } from "../../../lib/data/staff-appointments";
import { readCaseBooking } from "../../../lib/support/case-workspace";
import { caseBookingStatus } from "../../../lib/support/case-booking-status";
import { mapConsulteeEvents } from "../../../lib/appointments/map-consultee";
import { mapConsultantAppointments } from "../../../lib/appointments/map-consultant";
import { mapAppointmentDetail } from "../../../lib/appointments/map-detail";
import { toPresentationInput } from "../../../lib/appointments/presentation-input";
import { appointmentStatusChip } from "../../../lib/appointments/occurrences";
import { deriveBookingPresentation } from "../../../lib/dashboard/money-state";
import { staffStatus } from "../../../components/dashboard/shared/OperatorAppointmentsClient";
import {
  rowStatus,
  type AppointmentRow,
} from "../../../app/dashboard/organization/[orgId]/appointments/AppointmentsPageClient";

const DAY_MS = 24 * HOUR_MS;
/** Ended three hours ago: past the one-hour completion buffer. */
const pastWindow = () => {
  const startsAt = new Date(Date.now() - 4 * HOUR_MS);
  return { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) };
};

async function deliveredSession(
  appointmentId: string,
  consultantProfileId: string,
) {
  const { startsAt, endsAt } = pastWindow();
  return prisma.appointmentOccurrence.create({
    data: {
      appointmentId,
      ordinal: 1,
      startsAt,
      endsAt,
      isTentative: false,
      consultantProfileId,
      completionStatus: "COMPLETED",
      completedAt: endsAt,
    },
  });
}

type Seeded = {
  entityId: string;
  occurrenceId: string;
  status: () => Promise<string>;
};

/** One booking per kind whose single session ran and was delivered: auto-complete's cohort. */
const SEEDS: Record<string, () => Promise<Seeded>> = {
  async webinar() {
    const host = await seedHost();
    const plan = await prisma.webinarPlan.create({
      data: {
        title: `Parked webinar ${randomUUID().slice(0, 8)}`,
        price: BigInt(50_000),
        maxParticipants: 10,
        consultantProfileId: host.consultantProfileId,
      },
    });
    const webinar = await prisma.webinar.create({
      data: {
        webinarPlanId: plan.id,
        status: "SCHEDULED",
        maxParticipants: 10,
      },
    });
    const appointment = await prisma.appointment.create({
      data: { appointmentType: "WEBINAR", webinarId: webinar.id },
    });
    const occ = await deliveredSession(
      appointment.id,
      host.consultantProfileId,
    );
    return {
      entityId: webinar.id,
      occurrenceId: occ.id,
      status: async () =>
        (await prisma.webinar.findUniqueOrThrow({ where: { id: webinar.id } }))
          .status,
    };
  },
  async class() {
    const host = await seedHost();
    const plan = await prisma.classPlan.create({
      data: {
        title: `Parked class ${randomUUID().slice(0, 8)}`,
        price: BigInt(10_000),
        totalSessions: 1,
        consultantProfileId: host.consultantProfileId,
      },
    });
    const cls = await prisma.class.create({
      data: { classPlanId: plan.id, status: "SCHEDULED" },
    });
    const appointment = await prisma.appointment.create({
      data: { appointmentType: "CLASS", classId: cls.id },
    });
    const occ = await deliveredSession(
      appointment.id,
      host.consultantProfileId,
    );
    return {
      entityId: cls.id,
      occurrenceId: occ.id,
      status: async () =>
        (await prisma.class.findUniqueOrThrow({ where: { id: cls.id } }))
          .status,
    };
  },
  async consultation() {
    const seeded = await seedOneToOne(
      "consultation",
      await seedHost(),
      await seedConsultee(),
      pastWindow(),
      {
        status: "APPROVED",
        isTentative: false,
        completionStatus: "COMPLETED",
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );
    const id = seeded.consultationId!;
    return {
      entityId: id,
      occurrenceId: seeded.occurrenceId,
      status: async () =>
        (await prisma.consultation.findUniqueOrThrow({ where: { id } })).status,
    };
  },
  async subscription() {
    const host = await seedHost();
    const buyer = await seedConsultee();
    const now = Date.now();
    const plan = await prisma.subscriptionPlan.create({
      data: {
        title: "Parked plan",
        price: BigInt(100_000),
        totalSessions: 1,
        sessionsPerWeek: 1,
        durationInMonths: 1,
        consultantProfileId: host.consultantProfileId,
      },
    });
    const subscription = await prisma.subscription.create({
      data: {
        subscriptionPlanId: plan.id,
        requestedById: buyer.consulteeProfileId,
        status: "APPROVED",
        bookingSource: "DIRECT_CHECKOUT",
        sessionsTotal: 1,
        schedulingPeriodStartsAt: new Date(now - 2 * DAY_MS),
        schedulingPeriodEndsAt: new Date(now + 5 * DAY_MS),
        planEndsAt: new Date(now + 25 * DAY_MS),
        schedulingTimezone: "UTC",
      },
    });
    const appointment = await prisma.appointment.create({
      data: {
        appointmentType: "SUBSCRIPTION",
        subscriptionId: subscription.id,
      },
    });
    const occ = await deliveredSession(
      appointment.id,
      host.consultantProfileId,
    );
    return {
      entityId: subscription.id,
      occurrenceId: occ.id,
      status: async () =>
        (
          await prisma.subscription.findUniqueOrThrow({
            where: { id: subscription.id },
          })
        ).status,
    };
  },
  async trial() {
    const host = await seedHost();
    const buyer = await seedConsultee();
    const plan = await prisma.subscriptionPlan.create({
      data: {
        title: "Parked trial plan",
        price: BigInt(100_000),
        consultantProfileId: host.consultantProfileId,
      },
    });
    const appointment = await prisma.appointment.create({
      data: { appointmentType: "TRIAL" },
    });
    const trial = await prisma.trial.create({
      data: {
        consulteeProfileId: buyer.consulteeProfileId,
        consultantProfileId: host.consultantProfileId,
        subscriptionPlanId: plan.id,
        status: "SCHEDULED",
        appointmentId: appointment.id,
      },
    });
    const occ = await deliveredSession(
      appointment.id,
      host.consultantProfileId,
    );
    return {
      entityId: trial.id,
      occurrenceId: occ.id,
      status: async () =>
        (await prisma.trial.findUniqueOrThrow({ where: { id: trial.id } }))
          .status,
    };
  },
};
const KINDS = Object.keys(SEEDS);

afterEach(() => {
  mockPark.entityId = null;
  mockPark.occurrenceId = null;
});

describe("auto-complete's final CAS refuses a booking with a parked session", () => {
  it.each(KINDS)("%s: a delivered booking completes", async (kind) => {
    const booking = await SEEDS[kind]();
    await autoCompleteAppointments({ startedAt: Date.now() });
    expect(await booking.status()).toBe("COMPLETED");
  });

  it.each(KINDS)(
    "%s: a session parked after the cohort read keeps it open",
    async (kind) => {
      const booking = await SEEDS[kind]();
      mockPark.entityId = booking.entityId;
      mockPark.occurrenceId = booking.occurrenceId;
      await autoCompleteAppointments({ startedAt: Date.now() });
      expect(await booking.status()).not.toBe("COMPLETED");
    },
  );
});

/** A consultation whose one past session was parked with `outcome`. */
async function parkedConsultation(
  status: "COMPLETED" | "APPROVED",
  outcome: "NOBODY_JOINED" | "INCONCLUSIVE",
  paid: boolean,
) {
  const host = await seedHost();
  const learner = await seedConsultee();
  const window = {
    startsAt: new Date(Date.now() - 3 * DAY_MS),
    endsAt: new Date(Date.now() - 3 * DAY_MS + HOUR_MS),
  };
  const seeded = await seedOneToOne("consultation", host, learner, window, {
    status,
    isTentative: false,
    completionStatus: "UNVERIFIED",
    ...(paid && { payment: { status: "SUCCEEDED", expiresAt: null } }),
  });
  await prisma.appointmentOccurrence.update({
    where: { id: seeded.occurrenceId },
    data: { outcome },
  });
  return { host, learner, appointmentId: seeded.appointmentId };
}

/** The chip each list and detail reader gives the booking. */
async function labelsEverywhere(
  b: Awaited<ReturnType<typeof parkedConsultation>>,
) {
  const now = new Date();
  const learnerRow = mapConsulteeEvents(
    await readConsulteeEvents(b.learner.consulteeProfileId, {
      kind: "personal",
    }),
    now,
  ).find((vm) => vm.appointmentId === b.appointmentId);
  const expertPage = await readConsultantAppointmentsPage({
    consultantProfileId: b.host.consultantProfileId,
    scope: { kind: "personal" },
  } as Parameters<typeof readConsultantAppointmentsPage>[0]);
  const expertRow = mapConsultantAppointments(
    {
      consultantId: b.host.consultantProfileId,
      appointments: expertPage.rows,
    } as unknown as Parameters<typeof mapConsultantAppointments>[0],
    now,
  ).find((vm) => vm.appointmentId === b.appointmentId);
  const detail = scopeAppointmentDetail(
    (await readAppointmentDetail(b.appointmentId))!,
    { userId: b.learner.userId, managesGroupPlan: false },
  );
  const page = deriveBookingPresentation(
    toPresentationInput(detail, {
      viewerId: b.learner.userId,
      names: { payer: "you", consultant: "the expert" },
      sponsorOrgName: null,
    }),
    "CONSULTEE",
    { viewerZone: "UTC" },
  );
  const { vm: pageVm } = mapAppointmentDetail(detail, "consultee", now);
  const listed = await listAppointmentsScoped({
    scope: { kind: "personal" },
    userId: b.learner.userId,
  });
  const orgRow = listed.items.find((a) => a.id === b.appointmentId);
  const staff = (
    await getStaffAppointments({
      scope: { kind: "all" },
      limit: 100,
    } as Parameters<typeof getStaffAppointments>[0])
  ).appointments.find((a) => a.id === b.appointmentId);
  const caseRow = await readCaseBooking(b.appointmentId, {
    id: b.learner.userId,
    name: "Learner",
  });
  return {
    learnerList:
      learnerRow && appointmentStatusChip(learnerRow, "consultee").label,
    expertList:
      expertRow && appointmentStatusChip(expertRow, "consultant").label,
    page: page.bookingState.label,
    pageChip: appointmentStatusChip(pageVm, "consultee").label,
    orgList: orgRow && rowStatus(orgRow as unknown as AppointmentRow).label,
    staffList: staff && staffStatus(staff).label,
    caseDrawer: caseRow && caseBookingStatus(caseRow)?.label,
    nextAction: page.nextAction.kind,
  };
}

describe("a stored COMPLETED booking with a parked session reads honestly everywhere", () => {
  it("a paid no-join waits on a decision on every list and page, with no Rate", async () => {
    const labels = await labelsEverywhere(
      await parkedConsultation("COMPLETED", "NOBODY_JOINED", true),
    );
    expect(labels).toEqual(EVERYWHERE_WAITING);
  });

  it("a live booking whose session ran inconclusive waits too, never Completed", async () => {
    const labels = await labelsEverywhere(
      await parkedConsultation("APPROVED", "INCONCLUSIVE", false),
    );
    expect(labels).toEqual(EVERYWHERE_WAITING);
  });

  it("a free no-join completes, so it reads Completed", async () => {
    const labels = await labelsEverywhere(
      await parkedConsultation("COMPLETED", "NOBODY_JOINED", false),
    );
    expect(labels).toMatchObject({
      learnerList: "Completed",
      expertList: "Completed",
      page: "Completed",
      orgList: "Completed",
      staffList: "Completed",
      caseDrawer: "Completed",
    });
  });
});

const word = "Waiting on a decision";
const EVERYWHERE_WAITING = {
  learnerList: word,
  expertList: word,
  page: word,
  pageChip: word,
  orgList: word,
  staffList: word,
  caseDrawer: word,
  nextAction: "NONE",
};
