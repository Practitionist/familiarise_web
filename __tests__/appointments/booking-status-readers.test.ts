/**
 * What each list READS decides what it can say. A stored booking goes through
 * a screen's real reader (its query projected onto a mocked Prisma) and then
 * its mapper, and must read the same word and land in the same place as its
 * page: pay-first holds live and lapsed, a paid plan waiting for its times, a
 * held seat paid or not, and a booking being moved.
 */

import { projectRow } from "../fixtures/prisma-projection";

type Row = Record<string, unknown>;
const mockRows: Record<string, Row[]> = {};
const mockFind = (model: string) => (args: Row) =>
  Promise.resolve((mockRows[model] ?? []).map((r) => projectRow(r, args)));
jest.mock("@/lib/prisma", () => {
  const db = {
    appointment: {
      findMany: (a: Row) => mockFind("appointment")(a),
      count: () => Promise.resolve((mockRows.appointment ?? []).length),
    },
    user: { findMany: () => Promise.resolve([]) },
    consulteeProfile: {
      findUnique: () => Promise.resolve({ userId: "u-l" }),
    },
    consultation: { findMany: (a: Row) => mockFind("consultation")(a) },
    subscription: { findMany: (a: Row) => mockFind("subscription")(a) },
    webinar: { findMany: (a: Row) => mockFind("webinar")(a) },
    class: { findMany: (a: Row) => mockFind("class")(a) },
    trial: { findMany: (a: Row) => mockFind("trial")(a) },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return { __esModule: true, default: db };
});
jest.mock("@/lib/appointments/report-anomalies", () => ({
  bookingAnomalies: () => [],
  scheduleAnomalyReport: () => undefined,
}));
jest.mock("@/lib/enterprise/related-party", () => ({
  readOrgOwnerUserIds: () => Promise.resolve(new Set<string>()),
}));

import { readConsultantAppointmentsPage } from "@/lib/data/consultant-appointments";
import { readConsulteeEvents } from "@/lib/data/consultee-events-read";
import { listAppointmentsScoped } from "@/lib/api/scope/list-appointments";
import { getStaffAppointments } from "@/lib/data/staff-appointments";
import { staffStatus } from "@/components/dashboard/shared/OperatorAppointmentsClient";
import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import { appointmentStatusChip } from "@/lib/appointments/occurrences";
import { processAllEvents } from "@/app/dashboard/consultee/[consulteeId]/(features)/home/event-processor";
import {
  rowStatus,
  type AppointmentRow,
} from "@/app/dashboard/organization/[orgId]/appointments/AppointmentsPageClient";

const NOW = new Date();
const later = (ms: number) => new Date(NOW.getTime() + ms);
const user = (id: string, name: string) => ({
  id,
  name,
  image: null,
  email: `${id}@example.test`,
});
const expert = { id: "cp-1", userId: "u-e", user: user("u-e", "Hannah") };
const learner = { id: "cee-1", userId: "u-l", user: user("u-l", "Charlotte") };

type Pay = "live" | "lapsed" | "paid";
const payment = (pay: Pay) => ({
  id: "pay-1",
  userId: "u-l",
  paymentStatus: { live: "PENDING", lapsed: "EXPIRED", paid: "SUCCEEDED" }[pay],
  paymentMethod: "CARD",
  organizationId: null,
  expiresAt: pay === "lapsed" ? later(-60_000) : later(15 * 60_000),
  amount: 50_000,
  currency: "INR",
  createdAt: later(-60_000),
  deletedAt: null,
  refunds: [],
});
const occurrence = (tentative: boolean) => ({
  id: "occ-1",
  appointmentId: "appt-1",
  ordinal: 1,
  startsAt: later(86_400_000),
  endsAt: later(90_000_000),
  isTentative: tentative,
  completionStatus: "SCHEDULED",
  outcome: null,
  deletedAt: null,
  meeting: null,
});
const wrapper = (over: Row) => ({
  id: "appt-1",
  organizationId: null,
  consultationId: null,
  subscriptionId: null,
  webinarId: null,
  classId: null,
  deletedAt: null,
  createdAt: later(-60_000),
  rescheduleRequests: [],
  participants: [],
  consultation: null,
  subscription: null,
  webinar: null,
  class: null,
  trial: null,
  ...over,
});
const plan = {
  id: "plan-1",
  title: "Strategy call",
  price: 50_000,
  priceCurrency: "INR",
  durationInHours: 1,
  consultantProfileId: "cp-1",
  consultantProfile: expert,
};
const request = (status: string) => ({
  status,
  bookingSource: "DIRECT_CHECKOUT",
  requestedAt: later(-60_000),
  pendingPaymentUrl: null,
  requestNotes: null,
  requestedById: "cee-1",
  requestedBy: learner,
});

/** A 1:1 booked through checkout, as the stored rows hold it. */
function storedConsultation(status: string, pay: Pay, moving = false) {
  const consultation = {
    id: "c-1",
    ...request(status),
    consultationPlanId: "plan-1",
    consultationPlan: plan,
  };
  const appointment = wrapper({
    appointmentType: "CONSULTATION",
    consultationId: "c-1",
    occurrences: [occurrence(pay !== "paid")],
    payment: [payment(pay)],
    rescheduleRequests: moving
      ? [
          {
            id: "rr-1",
            status: "PENDING_REVIEW",
            reason: null,
            round: 1,
            expiresAt: later(86_400_000),
            initiatorRole: "CONSULTANT",
            initiatedById: "u-e",
            createdAt: later(-60_000),
            proposedTimes: [],
          },
        ]
      : [],
  });
  return { consultation, appointment };
}

/** A plan paid at checkout whose first sessions are not placed yet. */
function storedPaidPlanAwaitingTimes() {
  const subscription = {
    id: "s-1",
    ...request("PENDING"),
    deletedAt: null,
    subscriptionPlanId: "plan-1",
    subscriptionPlan: { ...plan, totalSessions: 4, sessionsPerWeek: 1 },
  };
  const appointment = wrapper({
    appointmentType: "SUBSCRIPTION",
    subscriptionId: "s-1",
    occurrences: [],
    payment: [payment("paid")],
  });
  return { subscription, appointment };
}

/** A webinar seat the learner holds, paid or not. */
function storedSeat(pay: Pay) {
  return {
    id: "w-1",
    status: "SCHEDULED",
    createdAt: later(-60_000),
    webinarPlan: { ...plan, collaborators: [] },
    appointment: wrapper({
      appointmentType: "WEBINAR",
      webinarId: "w-1",
      occurrences: [occurrence(false)],
      payment: [payment(pay)],
      participants: [
        {
          userId: "u-l",
          role: "CONSULTEE",
          status: pay === "paid" ? "CONFIRMED" : "HELD",
          updatedAt: later(-60_000),
        },
      ],
    }),
  };
}

function reset() {
  for (const key of Object.keys(mockRows)) delete mockRows[key];
}

async function expertVm(status: string, pay: Pay, moving = false) {
  reset();
  const { consultation, appointment } = storedConsultation(status, pay, moving);
  mockRows.appointment = [{ ...appointment, consultation }];
  const page = await readConsultantAppointmentsPage({
    consultantProfileId: "cp-1",
    scope: { kind: "personal" },
    now: NOW,
  } as Parameters<typeof readConsultantAppointmentsPage>[0]);
  const [vm] = mapConsultantAppointments(
    {
      consultantId: "cp-1",
      appointments: page.rows.slice(0, 1),
    } as unknown as Parameters<typeof mapConsultantAppointments>[0],
    NOW,
  );
  return vm;
}

async function learnerVms(seed: () => void) {
  reset();
  seed();
  const events = await readConsulteeEvents("cee-1", { kind: "personal" });
  return { events, vms: mapConsulteeEvents(events, NOW) };
}

async function orgRow(seed: Row) {
  reset();
  mockRows.appointment = [seed];
  const result = await listAppointmentsScoped({
    scope: { kind: "org", orgId: "org-1" },
    userId: "u-admin",
    now: NOW,
  } as Parameters<typeof listAppointmentsScoped>[0]);
  return rowStatus(result.items[0] as unknown as AppointmentRow).label;
}

describe("a pay-first 1:1 reads the same word through each list's real reader", () => {
  it.each([
    ["PENDING", "live", "Awaiting payment"],
    ["PENDING", "lapsed", "Cancelled"],
    ["APPROVED", "paid", "Confirmed"],
  ] as const)("%s with a %s payment reads %s", async (status, pay, word) => {
    const expertRow = await expertVm(status, pay);
    expect(appointmentStatusChip(expertRow, "consultant").label).toBe(word);
    const { vms } = await learnerVms(() => {
      const { consultation, appointment } = storedConsultation(status, pay);
      mockRows.consultation = [{ ...consultation, appointment }];
    });
    expect(appointmentStatusChip(vms[0], "consultee").label).toBe(word);
  });

  it("a paid plan waiting for its times is Confirmed and waits on the expert, never a Pay task", async () => {
    const { vms } = await learnerVms(() => {
      const { subscription, appointment } = storedPaidPlanAwaitingTimes();
      mockRows.subscription = [{ ...subscription, appointment }];
    });
    expect(appointmentStatusChip(vms[0], "consultee").label).toBe("Confirmed");
    expect(vms[0].needsActionReason).not.toBe("PAY_NOW");
    expect(vms[0].bucket).toBe("waiting");
  });
});

describe("a learner's webinar seat follows its own payment, on the list and on Home", () => {
  it("a held seat with a live order is a Pay task with its order and no Join", async () => {
    const { events, vms } = await learnerVms(() => {
      mockRows.webinar = [storedSeat("live")];
    });
    expect(appointmentStatusChip(vms[0], "consultee").label).toBe(
      "Awaiting payment",
    );
    expect(vms[0]).toMatchObject({
      bucket: "needsAction",
      needsActionReason: "PAY_NOW",
      pendingPaymentId: "pay-1",
    });
    const [card] = processAllEvents(events, NOW);
    expect(card).toMatchObject({
      needsActionReason: "PAY_NOW",
      bookingStatus: null,
    });
    expect(card.joinableSlot).toBeUndefined();
  });

  it("a held seat whose order lapsed is Cancelled on the list and absent from Home", async () => {
    const { events, vms } = await learnerVms(() => {
      mockRows.webinar = [storedSeat("lapsed")];
    });
    expect(appointmentStatusChip(vms[0], "consultee").label).toBe("Cancelled");
    expect(vms[0].bucket).toBe("cancelled");
    expect(processAllEvents(events, NOW)).toHaveLength(0);
  });

  it("a paid seat is Registered and joinable from Home", async () => {
    const { events, vms } = await learnerVms(() => {
      mockRows.webinar = [storedSeat("paid")];
    });
    expect(appointmentStatusChip(vms[0], "consultee").label).toBe("Registered");
    expect(processAllEvents(events, NOW)[0]).toMatchObject({
      bookingStatus: "CONFIRMED",
    });
  });
});

describe("the organisation list reads settled payments and open moves", () => {
  it("a paid plan waiting for its times reads Confirmed", async () => {
    const { subscription, appointment } = storedPaidPlanAwaitingTimes();
    expect(await orgRow({ ...appointment, subscription })).toBe("Confirmed");
  });

  it("a booking with an open move reads Being moved", async () => {
    const { consultation, appointment } = storedConsultation(
      "APPROVED",
      "paid",
      true,
    );
    expect(await orgRow({ ...appointment, consultation })).toBe("Being moved");
  });
});

describe("the expert's list and the back office read what their queries select", () => {
  it("the expert's list reads an open move as Being moved", async () => {
    const vm = await expertVm("PENDING", "paid", true);
    expect(appointmentStatusChip(vm, "consultant").label).toBe("Being moved");
  });

  it.each([
    ["PENDING", "live", "Awaiting payment"],
    ["PENDING", "lapsed", "Cancelled"],
    ["APPROVED", "paid", "Confirmed"],
  ] as const)(
    "the back office reads a %s 1:1 with a %s payment as %s",
    async (status, pay, word) => {
      reset();
      const { consultation, appointment } = storedConsultation(status, pay);
      mockRows.appointment = [{ ...appointment, consultation }];
      const { appointments } = await getStaffAppointments({
        scope: { kind: "all" },
      } as Parameters<typeof getStaffAppointments>[0]);
      expect(staffStatus(appointments[0]).label).toBe(word);
    },
  );
});

/** A paid trial holding its time, its pay window open or closed. */
function storedTrial(open: boolean) {
  return {
    id: "t-1",
    status: "AWAITING_PAYMENT",
    notes: null,
    requestedAt: later(-60_000),
    completedAt: null,
    pendingPaymentUrl: null,
    paymentDueAt: open ? later(15 * 60_000) : later(-60_000),
    consultantProfileId: "cp-1",
    consulteeProfileId: "cee-1",
    subscriptionPlan: {
      id: "plan-1",
      title: "Mentorship",
      trialDurationMinutes: 30,
      trialPriceInPaise: 10_000,
      consultantProfile: expert,
    },
    consulteeProfile: learner,
    appointment: wrapper({
      appointmentType: "TRIAL",
      occurrences: [occurrence(true)],
      payment: [{ ...payment(open ? "live" : "lapsed") }],
    }),
  };
}

describe("a trial's own pay window decides its row", () => {
  it("an open window is a Pay task; a closed one is Cancelled with no Pay, on the list and on Home", async () => {
    const live = await learnerVms(() => {
      mockRows.trial = [storedTrial(true)];
    });
    expect(appointmentStatusChip(live.vms[0], "consultee").label).toBe(
      "Awaiting payment",
    );
    expect(live.vms[0].needsActionReason).toBe("PAY_NOW");

    const lapsed = await learnerVms(() => {
      mockRows.trial = [storedTrial(false)];
    });
    const [vm] = lapsed.vms;
    expect(appointmentStatusChip(vm, "consultee").label).toBe("Cancelled");
    expect(vm.bucket).toBe("cancelled");
    expect(vm.pendingPaymentUrl).toBeNull();
    expect(processAllEvents(lapsed.events, NOW)).toHaveLength(0);
  });

  it("the expert's list reads a closed trial window as Cancelled", () => {
    const t = storedTrial(false);
    const [vm] = mapConsultantAppointments(
      {
        consultantId: "cp-1",
        appointments: [],
        scheduledTrials: [t],
      } as unknown as Parameters<typeof mapConsultantAppointments>[0],
      NOW,
    );
    expect(appointmentStatusChip(vm, "consultant").label).toBe("Cancelled");
    expect(vm.bucket).toBe("cancelled");
  });
});

describe("a learner's lapsed seat stays Cancelled after the host completes the event", () => {
  it("a held seat whose order lapsed is Cancelled, not Past, on a completed webinar", async () => {
    const { vms } = await learnerVms(() => {
      mockRows.webinar = [{ ...storedSeat("lapsed"), status: "COMPLETED" }];
    });
    expect(appointmentStatusChip(vms[0], "consultee").label).toBe("Cancelled");
    expect(vms[0].bucket).toBe("cancelled");
  });

  it("a paid seat on a completed webinar is Past", async () => {
    const { vms } = await learnerVms(() => {
      mockRows.webinar = [{ ...storedSeat("paid"), status: "COMPLETED" }];
    });
    expect(vms[0].bucket).toBe("past");
  });
});

describe("Home leaves out a hold that can no longer be paid", () => {
  it("a lapsed pay-first 1:1 is not on Home; a live one is a Pay task", async () => {
    const lapsed = await learnerVms(() => {
      const { consultation, appointment } = storedConsultation(
        "PENDING",
        "lapsed",
      );
      mockRows.consultation = [{ ...consultation, appointment }];
    });
    expect(processAllEvents(lapsed.events, NOW)).toHaveLength(0);
    const live = await learnerVms(() => {
      const { consultation, appointment } = storedConsultation(
        "PENDING",
        "live",
      );
      mockRows.consultation = [{ ...consultation, appointment }];
    });
    expect(processAllEvents(live.events, NOW)[0]).toMatchObject({
      needsActionReason: "PAY_NOW",
    });
  });
});

describe("sweep: the viewer's own facts before the host's or the clock's shortcut", () => {
  it("a held unpaid seat on a completed webinar is Cancelled on the badge and the tab", async () => {
    const { vms } = await learnerVms(() => {
      mockRows.webinar = [{ ...storedSeat("live"), status: "COMPLETED" }];
    });
    expect(appointmentStatusChip(vms[0], "consultee").label).toBe("Cancelled");
    expect(vms[0].bucket).toBe("cancelled");
  });

  it("the back office reads a pending order past its expiry as Cancelled", async () => {
    reset();
    const { consultation, appointment } = storedConsultation("PENDING", "live");
    const expired = {
      ...appointment,
      payment: [{ ...payment("live"), expiresAt: later(-60_000) }],
    };
    mockRows.appointment = [{ ...expired, consultation }];
    const { appointments } = await getStaffAppointments({
      scope: { kind: "all" },
    } as Parameters<typeof getStaffAppointments>[0]);
    expect(staffStatus(appointments[0]).label).toBe("Cancelled");
  });

  it("a captured payment the status has not caught up with is not a Pay task", async () => {
    const { vms } = await learnerVms(() => {
      const { consultation, appointment } = storedConsultation(
        "APPROVED_PENDING_PAYMENT",
        "paid",
      );
      mockRows.consultation = [{ ...consultation, appointment }];
    });
    expect(vms[0].needsActionReason).not.toBe("PAY_NOW");
  });
});
