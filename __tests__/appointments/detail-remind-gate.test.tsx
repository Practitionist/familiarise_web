/**
 * The detail page's Remind follows the remind route's own rule: the read ships
 * the open order's expiry (never the payer's email), and the callout offers
 * Remind only until that instant. Withdraw stays in every case.
 */

const findUnique = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findUnique: (...a: unknown[]) => findUnique(...a) },
  },
}));
jest.mock("../../lib/appointments/report-anomalies", () => ({
  bookingAnomalies: () => [],
  scheduleAnomalyReport: () => undefined,
}));

import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import {
  NeedsYouCallout,
  type AwaitingPaymentActions,
} from "@/components/appointments/detail/NeedsYouCallout";
import type { BookingPresentation } from "@/lib/dashboard/money-state";

const HOUR = 3_600_000;
const PAYER_EMAIL = "payer-secret@test";

const pending = (over: Record<string, unknown> = {}) => ({
  id: "pay-1",
  paymentStatus: "PENDING",
  createdAt: new Date(Date.now() - HOUR),
  expiresAt: new Date(Date.now() + 20 * HOUR),
  deletedAt: null,
  ...over,
});

const row = (
  over: {
    appointment?: Record<string, unknown>;
    email?: string | null;
    payment?: unknown[];
  } = {},
) => ({
  id: "appt-1",
  deletedAt: null,
  webinarId: null,
  classId: null,
  subscription: null,
  webinar: null,
  class: null,
  trial: null,
  consultation: {
    id: "c-1",
    status: "APPROVED_PENDING_PAYMENT",
    pendingPaymentUrl: "https://rzp.io/l/abc",
    consultationPlan: { consultantProfile: { id: "cp-1", userId: "u-cp" } },
    requestedBy: {
      id: "ce-1",
      userId: "u-payer",
      user: {
        id: "u-payer",
        name: "Payer",
        image: null,
        timezone: "Asia/Kolkata",
        email: over.email === undefined ? PAYER_EMAIL : over.email,
      },
    },
  },
  payment: over.payment ?? [pending()],
  rescheduleRequests: [],
  occurrences: [],
  statusHistory: [],
  participants: [],
  ...over.appointment,
});

describe("readAppointmentDetail → reminderExpiresAt", () => {
  it("ships the open order's expiry and never the payer's email", async () => {
    const order = pending();
    findUnique.mockResolvedValue(row({ payment: [order] }));
    const detail = await readAppointmentDetail("appt-1");
    expect(detail?.reminderExpiresAt).toBe(order.expiresAt.toISOString());
    expect(JSON.stringify(detail)).not.toContain(PAYER_EMAIL);
    expect(
      detail?.appointment.consultation?.requestedBy.user,
    ).not.toHaveProperty("email");
    // The email is read for the gate only, from the 1:1 payer's own select.
    const include = findUnique.mock.calls[0][0].include;
    expect(
      include.consultation.include.requestedBy.select.user.select.email,
    ).toBe(true);
  });

  it.each([
    [
      "the pay link has expired",
      row({ payment: [pending({ expiresAt: new Date(Date.now() - HOUR) })] }),
    ],
    [
      "no PENDING order exists",
      row({ payment: [pending({ paymentStatus: "EXPIRED" })] }),
    ],
    ["the payer has no email", row({ email: null })],
    [
      "the order is soft-deleted",
      row({ payment: [pending({ deletedAt: new Date() })] }),
    ],
    [
      "the booking is soft-deleted",
      row({ appointment: { deletedAt: new Date() } }),
    ],
  ])("is null when %s", async (_case, appointment) => {
    findUnique.mockResolvedValue(appointment);
    const detail = await readAppointmentDetail("appt-1");
    expect(detail?.reminderExpiresAt).toBeNull();
  });
});

const presentation = {
  nextAction: { kind: "REMIND_OR_WITHDRAW" },
  bookingState: { state: "AWAITING_PAYMENT" },
} as unknown as BookingPresentation;

const callout = (reminderExpiresAt: string | null) => {
  const actions: AwaitingPaymentActions = {
    reminderExpiresAt,
    remind: jest.fn(),
    withdraw: jest.fn(),
    onChanged: jest.fn(),
  };
  return (
    <NeedsYouCallout
      presentation={presentation}
      names={{ payer: "Payer", consultant: "Expert" }}
      heldCount={1}
      awaitingPayment={actions}
      pending={null}
      onHelp={() => undefined}
    />
  );
};

const remindButton = () => screen.queryByRole("button", { name: /remind/i });
const withdrawButton = () =>
  screen.queryByRole("button", { name: /withdraw approval/i });

describe("NeedsYouCallout → Remind", () => {
  afterEach(() => jest.useRealTimers());

  it("offers Remind while the order is live and drops it at the expiry", () => {
    jest.useFakeTimers();
    const expiry = new Date(Date.now() + HOUR).toISOString();
    render(callout(expiry));
    expect(remindButton()).not.toBeNull();
    act(() => {
      jest.advanceTimersByTime(HOUR + 1);
    });
    expect(remindButton()).toBeNull();
    expect(withdrawButton()).not.toBeNull();
  });

  it.each([
    ["no live order", null],
    ["an expired order", new Date(Date.now() - HOUR).toISOString()],
  ])("hides Remind but keeps Withdraw for %s", (_case, expiry) => {
    render(callout(expiry));
    expect(remindButton()).toBeNull();
    expect(withdrawButton()).not.toBeNull();
  });
});

describe("NeedsYouCallout → the pay-link line", () => {
  const withDeadline = (deadline: Date, reminderExpiresAt: string | null) => {
    const actions: AwaitingPaymentActions = {
      reminderExpiresAt,
      remind: jest.fn(),
      withdraw: jest.fn(),
      onChanged: jest.fn(),
    };
    return (
      <NeedsYouCallout
        presentation={
          {
            nextAction: { kind: "REMIND_OR_WITHDRAW", deadline },
            bookingState: { state: "AWAITING_PAYMENT" },
          } as unknown as BookingPresentation
        }
        names={{ payer: "Payer", consultant: "Expert" }}
        heldCount={1}
        awaitingPayment={actions}
        pending={null}
        onHelp={() => undefined}
      />
    );
  };

  it("names the deadline while the link is live", () => {
    const live = new Date(Date.now() + HOUR);
    render(withDeadline(live, live.toISOString()));
    expect(screen.getByText(/Payer has the payment link until/)).toBeTruthy();
  });

  it("an older lapsed order does not override the live one Remind reuses", () => {
    const past = new Date(Date.now() - HOUR);
    const live = new Date(Date.now() + HOUR);
    render(withDeadline(past, live.toISOString()));
    expect(screen.getByText(/Payer has the payment link until/)).toBeTruthy();
    expect(screen.queryByText(/has expired/)).toBeNull();
  });

  it("labels the header countdown as the hold's clock, not the link's", () => {
    const hold = new Date(Date.now() + 3 * HOUR);
    const link = new Date(Date.now() + HOUR);
    render(withDeadline(hold, link.toISOString()));
    expect(screen.getByText(/^Slot held [23]h \d+m$/)).toBeTruthy();
    expect(screen.queryByText(/left$/)).toBeNull();
  });

  it("says the link has expired once it has", () => {
    const past = new Date(Date.now() - HOUR);
    render(withDeadline(past, past.toISOString()));
    expect(screen.queryByText(/has the payment link until/)).toBeNull();
    expect(
      screen.getByText(/The payment link sent to Payer has expired\./),
    ).toBeTruthy();
  });
});
