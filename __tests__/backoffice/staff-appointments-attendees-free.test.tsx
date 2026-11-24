/**
 * The back-office Appointments list counts learners in a live seat, never the
 * host, and a booking that cost nothing reads "Free", not "₹0 • Paid".
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockFindMany = jest.fn(async (_args: unknown): Promise<unknown[]> => []);

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findMany: (args: unknown) => mockFindMany(args),
      count: async () => 1,
    },
    user: {
      findMany: async () => [
        { id: "u-host", name: "Bela", email: "b@x.test", image: null },
        { id: "u-learner", name: "Ravi", email: "r@x.test", image: null },
      ],
    },
  },
}));
jest.mock("next/navigation", () => ({
  usePathname: () => "/backoffice/appointments",
  useSearchParams: () => new URLSearchParams(""),
}));
jest.mock("@/lib/navigation/history", () => ({ replaceUrl: jest.fn() }));
jest.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => true }));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/components/dashboard/shared/AppointmentTimeline", () => ({
  AppointmentTimeline: () => null,
}));

import { APPOINTMENT_HEADLINE_SELECT } from "../../lib/data/appointment-headline";
import { getStaffAppointments } from "../../lib/data/staff-appointments";
import { OperatorAppointmentsClient } from "../../components/dashboard/shared/OperatorAppointmentsClient";

/** A free consultation settled as a ₹0 payment, as the list's findMany returns it. */
const freeConsultation = {
  id: "apt-free",
  createdAt: new Date("2026-11-10T10:00:00Z"),
  appointmentType: "CONSULTATION",
  deletedAt: null,
  _count: { participants: 1, occurrences: 0 },
  rescheduleRequests: [],
  occurrences: [
    {
      id: "o1",
      startsAt: new Date("2026-11-20T10:00:00Z"),
      endsAt: new Date("2026-11-20T10:30:00Z"),
      isTentative: false,
    },
  ],
  payment: [
    {
      id: "p1",
      amount: 0,
      currency: "INR",
      paymentStatus: "SUCCEEDED",
      paymentGateway: "RAZORPAY",
      expiresAt: null,
      createdAt: new Date("2026-11-10T10:00:00Z"),
    },
  ],
  consultation: {
    id: "c1",
    status: "APPROVED",
    bookingSource: "DIRECT_CHECKOUT",
    consultationPlan: {
      id: "plan-1",
      title: "qa-S-08 free consultation",
      price: 0,
      priceCurrency: "INR",
      durationInHours: 0.5,
      consultantProfile: { userId: "u-host" },
    },
    requestedBy: { userId: "u-learner" },
  },
  subscription: null,
  trial: null,
  webinar: null,
  class: null,
};

it("counts consultee seats in a live status, never the host's row", async () => {
  const where = APPOINTMENT_HEADLINE_SELECT._count.select.participants.where;
  expect(where).toMatchObject({
    role: "CONSULTEE",
    status: { in: expect.arrayContaining(["CONFIRMED"]) },
  });
  expect(JSON.stringify(where)).not.toContain("CANCELLED");

  await getStaffAppointments({ scope: { kind: "all" } });
  const args = mockFindMany.mock.calls[0]?.[0] as {
    select: { _count: { select: { participants: { where: unknown } } } };
  };
  expect(args.select._count.select.participants.where).toEqual(where);
});

it("reads a ₹0 booking as Free in the reader and on the row", async () => {
  mockFindMany.mockResolvedValueOnce([freeConsultation]);
  const payload = await getStaffAppointments({ scope: { kind: "all" } });
  expect(payload.appointments[0]).toMatchObject({
    free: true,
    hasIssue: false,
  });

  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => JSON.parse(JSON.stringify(payload)),
  })) as unknown as typeof fetch;
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OperatorAppointmentsClient />
    </QueryClientProvider>,
  );

  expect(
    await screen.findByText("qa-S-08 free consultation"),
  ).toBeInTheDocument();
  // The row's meta line says Free and carries no amount at all.
  const free = screen.getByText("Free");
  expect(free.parentElement?.textContent).not.toMatch(/₹/);
});
