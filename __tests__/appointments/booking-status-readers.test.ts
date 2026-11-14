/**
 * What each list READS decides what it can say. A stored booking goes through
 * the expert's and the learner's real readers (their queries projected onto a
 * mocked Prisma) and then their mappers, and must read the same word as its
 * page: a live pay-first hold, a lapsed one and a paid booking.
 */

import { projectRow } from "../fixtures/prisma-projection";

const mockFindManyAppointments = jest.fn();
const mockFindManyConsultations = jest.fn();
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findMany: (a: unknown) => mockFindManyAppointments(a) },
    consulteeProfile: {
      findUnique: () => Promise.resolve({ userId: "u-l" }),
    },
    consultation: { findMany: (a: unknown) => mockFindManyConsultations(a) },
    subscription: { findMany: () => Promise.resolve([]) },
    webinar: { findMany: () => Promise.resolve([]) },
    class: { findMany: () => Promise.resolve([]) },
    trial: { findMany: () => Promise.resolve([]) },
  },
}));
jest.mock("@/lib/appointments/report-anomalies", () => ({
  bookingAnomalies: () => [],
  scheduleAnomalyReport: () => undefined,
}));

import { readConsultantAppointmentsPage } from "@/lib/data/consultant-appointments";
import { readConsulteeEvents } from "@/lib/data/consultee-events-read";
import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import { appointmentStatusChip } from "@/lib/appointments/occurrences";

const NOW = new Date();
const later = (ms: number) => new Date(NOW.getTime() + ms);

function stored(kind: "live" | "lapsed" | "paid") {
  const user = (id: string, name: string) => ({
    id,
    name,
    image: null,
    email: `${id}@example.test`,
  });
  const plan = {
    id: "plan-1",
    title: "Strategy call",
    price: 50_000,
    priceCurrency: "INR",
    durationInHours: 1,
    consultantProfileId: "cp-1",
    consultantProfile: {
      id: "cp-1",
      userId: "u-e",
      user: user("u-e", "Hannah"),
    },
  };
  const consultation = {
    id: "c-1",
    status: kind === "paid" ? "APPROVED" : "PENDING",
    bookingSource: "DIRECT_CHECKOUT",
    requestedAt: later(-60_000),
    pendingPaymentUrl: null,
    requestNotes: null,
    consultationPlanId: "plan-1",
    requestedById: "cee-1",
    consultationPlan: plan,
    requestedBy: { id: "cee-1", userId: "u-l", user: user("u-l", "Charlotte") },
  };
  const appointment = {
    id: "appt-1",
    appointmentType: "CONSULTATION",
    organizationId: null,
    consultationId: "c-1",
    subscriptionId: null,
    webinarId: null,
    classId: null,
    deletedAt: null,
    createdAt: later(-60_000),
    occurrences: [
      {
        id: "occ-1",
        appointmentId: "appt-1",
        ordinal: 1,
        startsAt: later(86_400_000),
        endsAt: later(90_000_000),
        isTentative: kind !== "paid",
        completionStatus: "SCHEDULED",
        outcome: null,
        deletedAt: null,
        meeting: null,
      },
    ],
    payment: [
      {
        id: "pay-1",
        userId: "u-l",
        paymentStatus: {
          live: "PENDING",
          lapsed: "EXPIRED",
          paid: "SUCCEEDED",
        }[kind],
        paymentMethod: "CARD",
        expiresAt: kind === "lapsed" ? later(-60_000) : later(15 * 60_000),
        amount: 50_000,
        currency: "INR",
        createdAt: later(-60_000),
        deletedAt: null,
        refunds: [],
      },
    ],
    rescheduleRequests: [],
    participants: [],
    subscription: null,
    webinar: null,
    class: null,
    trial: null,
  };
  return { consultation, appointment };
}

async function expertWord(kind: "live" | "lapsed" | "paid") {
  const { consultation, appointment } = stored(kind);
  const row = { ...appointment, consultation };
  mockFindManyAppointments.mockReset();
  mockFindManyAppointments
    .mockImplementationOnce((args: Record<string, unknown>) =>
      Promise.resolve([projectRow(row, args)]),
    )
    .mockResolvedValue([]);
  const page = await readConsultantAppointmentsPage({
    consultantProfileId: "cp-1",
    scope: { kind: "personal" },
    now: NOW,
  } as Parameters<typeof readConsultantAppointmentsPage>[0]);
  const [vm] = mapConsultantAppointments(
    {
      consultantId: "cp-1",
      appointments: page.rows,
    } as unknown as Parameters<typeof mapConsultantAppointments>[0],
    NOW,
  );
  return appointmentStatusChip(vm, "consultant").label;
}

async function learnerWord(kind: "live" | "lapsed" | "paid") {
  const { consultation, appointment } = stored(kind);
  const row = { ...consultation, appointment };
  mockFindManyConsultations.mockReset();
  mockFindManyConsultations.mockImplementation(
    (args: Record<string, unknown>) => Promise.resolve([projectRow(row, args)]),
  );
  const events = await readConsulteeEvents("cee-1", { kind: "personal" });
  const [vm] = mapConsulteeEvents(events, NOW);
  return appointmentStatusChip(vm, "consultee").label;
}

describe("a booking reads the same word through each list's real reader", () => {
  it.each([
    ["live", "Awaiting payment"],
    ["lapsed", "Cancelled"],
    ["paid", "Confirmed"],
  ] as const)("a %s pay-first booking reads %s", async (kind, word) => {
    expect(await expertWord(kind)).toBe(word);
    expect(await learnerWord(kind)).toBe(word);
  });
});
