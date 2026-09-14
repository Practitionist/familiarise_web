/**
 * @jest-environment node
 */

/**
 * #849 — cancelPendingCheckout unit tests.
 *
 * State-based prisma mock (same idiom as refund-operation.test.ts): the tx
 * stub mutates an in-memory store, CAS guards are exercised for real via the
 * mocked updateMany counts. Real-DB rollback semantics (Serializable tx) are
 * covered E2E by the chaos scenario test-cancel-pending-vs-webhook; here we
 * assert the business decisions (claims, scoping, transitions, gateway call).
 */

type Row = Record<string, unknown>;

interface SlotRow {
  id: string;
  appointmentId: string;
  cohortId: string | null;
  isTentative: boolean;
  completionStatus: string;
  deletedAt: Date | null;
  userIds: string[];
}

/** #1554 — a seat is an AppointmentParticipant row; cohortId rides along so
 *  the class-wide release (`appointment: { cohortId }`) can be matched. */
interface SeatRow {
  appointmentId: string;
  cohortId: string | null;
  userId: string;
  status: string;
}

interface Store {
  payments: Map<string, Row>;
  consultations: Map<string, Row>;
  subscriptions: Map<string, Row>;
  slots: SlotRow[];
  seats: SeatRow[];
}

let state: Store;

function newStore(): Store {
  return {
    payments: new Map(),
    consultations: new Map(),
    subscriptions: new Map(),
    slots: [],
    seats: [],
  };
}

interface SeatWhere {
  appointmentId?: string;
  appointment?: { cohortId?: string };
  userId?: string;
  status?: { in?: string[] };
}

function matchSeats(where: Row): SeatRow[] {
  const w = where as SeatWhere;
  return state.seats.filter((seat) => {
    let match = true;
    if (w.appointmentId !== undefined)
      match = match && seat.appointmentId === w.appointmentId;
    if (w.appointment?.cohortId !== undefined)
      match = match && seat.cohortId === w.appointment.cohortId;
    if (w.userId !== undefined) match = match && seat.userId === w.userId;
    if (w.status?.in !== undefined)
      match = match && w.status.in.includes(seat.status);
    return match;
  });
}

interface SlotWhere {
  appointmentId?: string;
  appointment?: { cohortId?: string };
  isTentative?: boolean;
  deletedAt?: Date | null;
  completionStatus?: { in?: string[] };
}

function matchSlots(where: Row): SlotRow[] {
  const w = where as SlotWhere;
  return state.slots.filter((slot) => {
    let match = true;
    if (w.appointmentId !== undefined)
      match = match && slot.appointmentId === w.appointmentId;
    if (w.appointment?.cohortId !== undefined)
      match = match && slot.cohortId === w.appointment.cohortId;
    if (w.isTentative !== undefined)
      match = match && slot.isTentative === w.isTentative;
    if (w.deletedAt === null) match = match && slot.deletedAt === null;
    if (w.completionStatus?.in !== undefined)
      match = match && w.completionStatus.in.includes(slot.completionStatus);
    return match;
  });
}

function makeTx() {
  return {
    payment: {
      findUnique: jest.fn(async ({ where }: any) => {
        const p = state.payments.get(where.id);
        if (!p) return null;
        // Hydrate the appointment include shape the module selects.
        return {
          ...p,
          appointment: p.appointmentId
            ? {
                id: p.appointmentId,
                consultation: p.consultationId
                  ? { id: p.consultationId }
                  : null,
                subscription: p.subscriptionId
                  ? { id: p.subscriptionId }
                  : null,
                webinar: p.webinarId ? { id: p.webinarId } : null,
                cohort: p.cohortId ? { id: p.cohortId } : null,
              }
            : null,
        };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const p = state.payments.get(where.id);
        if (!p) return { count: 0 };
        if (where.userId !== undefined && p.userId !== where.userId)
          return { count: 0 };
        if (
          where.paymentStatus !== undefined &&
          p.paymentStatus !== where.paymentStatus
        )
          return { count: 0 };
        Object.assign(p, data);
        return { count: 1 };
      }),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    consultation: {
      findUnique: jest.fn(
        async ({ where }: any) => state.consultations.get(where.id) ?? null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const c = state.consultations.get(where.id);
        if (!c) return { count: 0 };
        const allowed = where.status?.in as string[] | undefined;
        if (allowed && !allowed.includes(c.status as string))
          return { count: 0 };
        Object.assign(c, data);
        return { count: 1 };
      }),
    },
    subscription: {
      findUnique: jest.fn(
        async ({ where }: any) => state.subscriptions.get(where.id) ?? null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const s = state.subscriptions.get(where.id);
        if (!s) return { count: 0 };
        const allowed = where.status?.in as string[] | undefined;
        if (allowed && !allowed.includes(s.status as string))
          return { count: 0 };
        Object.assign(s, data);
        return { count: 1 };
      }),
    },
    appointmentOccurrence: {
      findMany: jest.fn(async ({ where }: any) =>
        matchSlots(where).map((slot) => ({
          id: slot.id,
          completionStatus: slot.completionStatus,
        })),
      ),
      updateManyAndReturn: jest.fn(
        async ({ where, data }: { where: Row; data: Row }) => {
          const moved = matchSlots(where);
          for (const slot of moved) Object.assign(slot, data);
          return moved.map((slot) => ({
            id: slot.id,
            appointmentId: slot.appointmentId,
          }));
        },
      ),
    },
    appointmentParticipant: {
      updateMany: jest.fn(
        async ({ where, data }: { where: Row; data: Row }) => {
          const moved = matchSeats(where);
          for (const seat of moved) Object.assign(seat, data);
          return { count: moved.length };
        },
      ),
    },
    referralCreditUsage: {
      findMany: jest.fn(async () => []),
    },
  };
}

let tx: ReturnType<typeof makeTx>;

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (fn: any, _opts: any) => fn(tx)),
  },
}));

jest.mock("../../scripts/payments/cleanup-abandoned-payments", () => ({
  __esModule: true,
  cancelPaymentIntent: jest.fn(async () => undefined),
}));

const mockReverseBookingUtilization = jest.fn(async () => ({
  reversed: false,
  engagementsReversed: 0,
  fullyReversed: false,
}));

jest.mock("../../lib/api/organizations/program-helpers", () => ({
  __esModule: true,
  reverseBookingUtilization: (...a: unknown[]) =>
    mockReverseBookingUtilization(...(a as [])),
}));

import { cancelPendingCheckout } from "../../lib/payments/operations/cancel-pending";
import { cancelPaymentIntent } from "../../scripts/payments/cleanup-abandoned-payments";
import { IllegalTransitionError } from "../../lib/enterprise/transitions";

function seedConsultationPayment({
  paymentStatus = "PENDING",
  status = "APPROVED_PENDING_PAYMENT",
  isMockPayment = false,
}: Partial<{
  paymentStatus: string;
  status: string;
  isMockPayment: boolean;
}> = {}) {
  state.payments.set("pay-1", {
    id: "pay-1",
    userId: "user-1",
    paymentStatus,
    paymentIntent: "order_abc",
    paymentGateway: "RAZORPAY",
    isMockPayment,
    appointmentId: "appt-1",
    consultationId: "cons-1",
    subscriptionId: null,
    webinarId: null,
    cohortId: null,
  });
  state.consultations.set("cons-1", {
    id: "cons-1",
    status,
  });
  state.slots.push({
    id: "slot-1",
    appointmentId: "appt-1",
    cohortId: null,
    isTentative: true,
    completionStatus: "SCHEDULED",
    deletedAt: null,
    userIds: ["user-1"],
  });
}

beforeEach(() => {
  state = newStore();
  tx = makeTx();
  jest.clearAllMocks();
});

describe("cancelPendingCheckout — happy path (consultation)", () => {
  it("expires the payment, releases tentative slots, cancels the parent, cancels the gateway intent", async () => {
    seedConsultationPayment({});

    const result = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-1",
    });

    expect(result).toEqual({ ok: true, slotsReleased: 1 });
    expect(state.payments.get("pay-1")?.paymentStatus).toBe("EXPIRED");
    // Freed by status, not deleted: the row stays so support can see the
    // hold the buyer abandoned (doctrine rule 2).
    expect(state.slots).toHaveLength(1);
    expect(state.slots[0].completionStatus).toBe("CANCELLED");
    expect(state.slots[0].deletedAt).toBeInstanceOf(Date);
    const cons = state.consultations.get("cons-1");
    expect(cons?.status).toBe("CANCELLED");
    expect(cons?.cancellationNotes).toBe("Cancelled by user during checkout");
    expect(cons?.cancelledAt).toBeInstanceOf(Date);
    expect(cancelPaymentIntent).toHaveBeenCalledWith("order_abc", "RAZORPAY");
    // #1333 — the slot history rows name the appointment the rows came back with.
    const slotHistory = (
      tx.bookingStatusHistory.create as jest.Mock
    ).mock.calls.filter(([call]) => call.data.entity === "OCCURRENCE");
    expect(slotHistory.length).toBeGreaterThan(0);
    for (const [call] of slotHistory) {
      expect(call.data).toEqual(
        expect.objectContaining({
          toStatus: "CANCELLED",
          appointmentId: "appt-1",
        }),
      );
    }
  });

  it("skips the gateway cancel for mock payments", async () => {
    seedConsultationPayment({ isMockPayment: true });

    const result = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-1",
    });

    expect(result.ok).toBe(true);
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("#1003 — returns the program engagement to the org's cap", async () => {
    // Checkout debits BookingUtilization inside the booking transaction,
    // BEFORE capture. Abandoning an org-funded checkout therefore burned a
    // contracted seat permanently until this reversal was wired in.
    seedConsultationPayment({});

    await cancelPendingCheckout({ paymentId: "pay-1", userId: "user-1" });

    expect(mockReverseBookingUtilization).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ paymentId: "pay-1" }),
    );
  });

  it("#1003 — does not reverse utilization when the cancel is refused", async () => {
    seedConsultationPayment({ paymentStatus: "SUCCEEDED" });

    await cancelPendingCheckout({ paymentId: "pay-1", userId: "user-1" });

    expect(mockReverseBookingUtilization).not.toHaveBeenCalled();
  });
});

describe("cancelPendingCheckout — CAS / status guards", () => {
  it("returns NOT_PENDING when the webhook already confirmed (SUCCEEDED), with zero writes", async () => {
    seedConsultationPayment({ paymentStatus: "SUCCEEDED" });

    const result = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-1",
    });

    expect(result).toEqual({ ok: false, code: "NOT_PENDING" });
    expect(state.payments.get("pay-1")?.paymentStatus).toBe("SUCCEEDED");
    expect(state.slots).toHaveLength(1);
    expect(state.slots[0].completionStatus).toBe("SCHEDULED");
    expect(state.slots[0].deletedAt).toBeNull();
    expect(state.consultations.get("cons-1")?.status).toBe(
      "APPROVED_PENDING_PAYMENT",
    );
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("second cancel of the same payment returns NOT_PENDING", async () => {
    seedConsultationPayment({});

    const first = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-1",
    });
    const second = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-1",
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, code: "NOT_PENDING" });
  });

  it("returns NOT_FOUND for a foreign user's payment, with zero writes", async () => {
    seedConsultationPayment({});

    const result = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-other",
    });

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(state.payments.get("pay-1")?.paymentStatus).toBe("PENDING");
    expect(state.slots).toHaveLength(1);
    expect(state.slots[0].deletedAt).toBeNull();
  });

  it("returns NOT_FOUND for a missing payment", async () => {
    const result = await cancelPendingCheckout({
      paymentId: "nope",
      userId: "user-1",
    });
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("cancelPendingCheckout — narrow parent from-set", () => {
  it("throws IllegalTransitionError when the parent is already SCHEDULED (another payment won)", async () => {
    seedConsultationPayment({ status: "SCHEDULED" });

    await expect(
      cancelPendingCheckout({ paymentId: "pay-1", userId: "user-1" }),
    ).rejects.toThrow(IllegalTransitionError);
    // The real DB rolls the whole Serializable tx back; the route maps the
    // error to 409. (E2E rollback covered by the chaos scenario.)
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });
});

describe("cancelPendingCheckout — subscription parent", () => {
  it("cancels the subscription parent through the guarded transition", async () => {
    state.payments.set("pay-s", {
      id: "pay-s",
      userId: "user-1",
      paymentStatus: "PENDING",
      paymentIntent: "order_s",
      paymentGateway: "RAZORPAY",
      isMockPayment: true,
      appointmentId: "appt-s",
      consultationId: null,
      subscriptionId: "sub-1",
      webinarId: null,
      cohortId: null,
    });
    state.subscriptions.set("sub-1", {
      id: "sub-1",
      status: "APPROVED_PENDING_PAYMENT",
    });
    state.slots.push({
      id: "slot-s",
      appointmentId: "appt-s",
      cohortId: null,
      isTentative: true,
      completionStatus: "SCHEDULED",
      deletedAt: null,
      userIds: ["user-1"],
    });

    const result = await cancelPendingCheckout({
      paymentId: "pay-s",
      userId: "user-1",
    });

    expect(result).toEqual({ ok: true, slotsReleased: 1 });
    expect(state.payments.get("pay-s")?.paymentStatus).toBe("EXPIRED");
    const sub = state.subscriptions.get("sub-1");
    expect(sub?.status).toBe("CANCELLED");
    expect(sub?.cancellationNotes).toBe("Cancelled by user during checkout");
    expect(sub?.cancelledAt).toBeInstanceOf(Date);
  });

  it("rolls back when the subscription parent is already SCHEDULED", async () => {
    state.payments.set("pay-s2", {
      id: "pay-s2",
      userId: "user-1",
      paymentStatus: "PENDING",
      paymentIntent: "order_s2",
      paymentGateway: "RAZORPAY",
      isMockPayment: true,
      appointmentId: "appt-s2",
      consultationId: null,
      subscriptionId: "sub-2",
      webinarId: null,
      cohortId: null,
    });
    state.subscriptions.set("sub-2", { id: "sub-2", status: "SCHEDULED" });

    await expect(
      cancelPendingCheckout({ paymentId: "pay-s2", userId: "user-1" }),
    ).rejects.toThrow(IllegalTransitionError);
  });
});

describe("cancelPendingCheckout — webinar scoping", () => {
  it("releases only the caller's seat on a shared webinar appointment", async () => {
    state.payments.set("pay-w", {
      id: "pay-w",
      userId: "user-1",
      paymentStatus: "PENDING",
      paymentIntent: "order_w",
      paymentGateway: "RAZORPAY",
      isMockPayment: false,
      appointmentId: "appt-w",
      consultationId: null,
      subscriptionId: null,
      webinarId: "web-1",
      cohortId: null,
    });
    state.slots.push({
      id: "slot-shared",
      appointmentId: "appt-w",
      cohortId: null,
      isTentative: false,
      completionStatus: "SCHEDULED",
      deletedAt: null,
      userIds: [],
    });
    state.seats.push(
      {
        appointmentId: "appt-w",
        cohortId: null,
        userId: "user-1",
        status: "HELD",
      },
      {
        appointmentId: "appt-w",
        cohortId: null,
        userId: "user-2",
        status: "HELD",
      },
    );

    const result = await cancelPendingCheckout({
      paymentId: "pay-w",
      userId: "user-1",
    });

    // #1554 — the caller's seat is released by status; the shared occurrence
    // survives untouched because other attendees share it.
    expect(result).toEqual({ ok: true, slotsReleased: 1 });
    expect(state.slots.map((s) => s.id)).toEqual(["slot-shared"]);
    expect(state.slots[0].completionStatus).toBe("SCHEDULED");
    expect(state.seats).toEqual([
      {
        appointmentId: "appt-w",
        cohortId: null,
        userId: "user-1",
        status: "CANCELLED",
      },
      {
        appointmentId: "appt-w",
        cohortId: null,
        userId: "user-2",
        status: "HELD",
      },
    ]);
  });
});

describe("cancelPendingCheckout — class scoping", () => {
  it("releases the caller's seat across all class session appointments", async () => {
    state.payments.set("pay-c", {
      id: "pay-c",
      userId: "user-1",
      paymentStatus: "PENDING",
      paymentIntent: "order_c",
      paymentGateway: "RAZORPAY",
      isMockPayment: false,
      appointmentId: "appt-c1",
      consultationId: null,
      subscriptionId: null,
      webinarId: null,
      cohortId: "class-1",
    });
    state.seats.push(
      {
        appointmentId: "appt-c1",
        cohortId: "class-1",
        userId: "user-1",
        status: "HELD",
      },
      {
        appointmentId: "appt-c2",
        cohortId: "class-1",
        userId: "user-1",
        status: "HELD",
      },
      {
        appointmentId: "appt-c2",
        cohortId: "class-1",
        userId: "user-2",
        status: "HELD",
      },
    );

    const result = await cancelPendingCheckout({
      paymentId: "pay-c",
      userId: "user-1",
    });

    expect(result).toEqual({ ok: true, slotsReleased: 2 });
    // The other student's seat stays put.
    expect(state.seats.map((seat) => `${seat.userId}:${seat.status}`)).toEqual([
      "user-1:CANCELLED",
      "user-1:CANCELLED",
      "user-2:HELD",
    ]);
  });
});

describe("cancelPendingCheckout — gateway cancel failure is non-fatal", () => {
  it("still reports success when the gateway cancel throws", async () => {
    seedConsultationPayment({});
    (cancelPaymentIntent as jest.Mock).mockRejectedValueOnce(
      new Error("gateway down"),
    );

    const result = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-1",
    });

    expect(result.ok).toBe(true);
    expect(state.payments.get("pay-1")?.paymentStatus).toBe("EXPIRED");
  });
});
