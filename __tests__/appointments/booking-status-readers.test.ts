/**
 * What each list READS decides what it can say. A stored booking goes through
 * a screen's real reader (its query projected onto a mocked Prisma) and then
 * its mapper, and must read the same word and land in the same place as its
 * page: pay-first holds live and lapsed, a paid plan waiting for its times, a
 * held seat paid or not, and a booking being moved.
 */

import { projectRow } from "../fixtures/prisma-projection";
import {
  NOW,
  later,
  payment,
  storedConsultation,
  storedLapsedMove,
  storedPaidPlanAwaitingTimes,
  storedSeat,
  storedTrial,
  type Pay,
} from "../fixtures/stored-bookings";

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
    appointmentOccurrence: { findMany: () => Promise.resolve([]) },
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
import {
  appointmentStatusChip,
  appointmentStatusLine,
} from "@/lib/appointments/occurrences";
import { openProposalTarget } from "@/lib/appointments/consultee-affordances";
import { processAllEvents } from "@/app/dashboard/consultee/[consulteeId]/(features)/home/event-processor";
import {
  rowStatus,
  type AppointmentRow,
} from "@/app/dashboard/organization/[orgId]/appointments/AppointmentsPageClient";

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

describe("a seat the host removed reads once, with no next session", () => {
  it("lists under Cancelled with one released line and no session ahead", async () => {
    const { vms } = await learnerVms(() => {
      const seat = storedSeat("paid");
      const appointment = seat.appointment as Row & {
        participants: Row[];
      };
      mockRows.webinar = [
        {
          ...seat,
          appointment: {
            ...appointment,
            participants: [
              { ...appointment.participants[0], status: "CANCELLED" },
            ],
          },
        },
      ];
    });
    const vm = vms[0];
    expect(vm.bucket).toBe("cancelled");
    expect(vm.nextAt).toBeNull();
    // The sheet prints the status line only when it differs from the row's meta.
    expect(appointmentStatusLine(vm, "consultee")).toBe(vm.meta);
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

describe("a move past its deadline reads as the original on every list, before anything settles it", () => {
  it("the learner's list and Home, the expert's list, the organisation list and the back office read Confirmed with nothing to answer", async () => {
    const { events, vms } = await learnerVms(() => {
      const { consultation, appointment } = storedLapsedMove();
      mockRows.consultation = [{ ...consultation, appointment }];
    });
    expect(appointmentStatusChip(vms[0], "consultee").label).toBe("Confirmed");
    expect(vms[0].reschedule).toBeFalsy();
    expect(vms[0].bucket).not.toBe("needsAction");
    expect(
      openProposalTarget([events.consultations?.[0]?.appointment ?? null]),
    ).toBeNull();
    expect(processAllEvents(events, NOW)[0]).toMatchObject({
      status: "APPROVED",
      needsActionReason: null,
    });

    reset();
    const lapsed = storedLapsedMove();
    mockRows.appointment = [
      { ...lapsed.appointment, consultation: lapsed.consultation },
    ];
    const page = await readConsultantAppointmentsPage({
      consultantProfileId: "cp-1",
      scope: { kind: "personal" },
      now: NOW,
    } as Parameters<typeof readConsultantAppointmentsPage>[0]);
    const [expertRow] = mapConsultantAppointments(
      {
        consultantId: "cp-1",
        appointments: page.rows.slice(0, 1),
      } as unknown as Parameters<typeof mapConsultantAppointments>[0],
      NOW,
    );
    expect(appointmentStatusChip(expertRow, "consultant").label).toBe(
      "Confirmed",
    );
    expect(expertRow.reschedule).toBeFalsy();

    expect(
      await orgRow({
        ...lapsed.appointment,
        consultation: lapsed.consultation,
      }),
    ).toBe("Confirmed");

    reset();
    mockRows.appointment = [
      { ...lapsed.appointment, consultation: lapsed.consultation },
    ];
    const { appointments } = await getStaffAppointments({
      scope: { kind: "all" },
    } as Parameters<typeof getStaffAppointments>[0]);
    expect(staffStatus(appointments[0]).label).toBe("Confirmed");
  });
});
