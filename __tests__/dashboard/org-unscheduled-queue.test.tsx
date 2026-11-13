// Invariant: the org Unscheduled queue lists PENDING requests as awaiting the
// expert (no Allocate) and APPROVED-unallocated ones with Allocate.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const consultationFindMany = jest.fn();
const subscriptionFindMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: (...a: unknown[]) => consultationFindMany(...a) },
    subscription: { findMany: (...a: unknown[]) => subscriptionFindMany(...a) },
  },
}));
jest.mock("next/navigation", () => ({ useParams: () => ({ orgId: "o1" }) }));
jest.mock("../../app/dashboard/organization/[orgId]/useOrgRole", () => ({
  useOrgRole: () => ({ can: () => true }),
}));
jest.mock(
  "../../app/dashboard/organization/[orgId]/appointments/AllocateOrgBookingDialog",
  () => ({
    AllocateOrgBookingDialog: ({
      appointmentId,
    }: {
      appointmentId: string;
    }) => <button data-allocate={appointmentId}>Allocate</button>,
  }),
);

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { readOrgPendingRequests } from "@/lib/data/org-pending-requests";
import { orgOwnedAppointmentWhere } from "@/lib/api/scope/list-appointments";
import { PayerRequestsView } from "../../app/dashboard/organization/[orgId]/appointments/PayerRequestsView";

const row = (id: string, status: string) => ({
  id,
  status,
  requestedAt: new Date("2026-10-01T00:00:00Z"),
  appointment: { id: `appt-${id}` },
  consultationPlan: {
    title: "Plan",
    consultantProfileId: "cp-1",
    durationInHours: 1,
    consultantProfile: { user: { name: "Expert" } },
  },
  requestedBy: { user: { name: "Learner" } },
});

beforeEach(() => {
  consultationFindMany.mockResolvedValue([
    row("pending", "PENDING"),
    row("approved", "APPROVED"),
  ]);
  subscriptionFindMany.mockResolvedValue([]);
});

it("reads PENDING and APPROVED-unallocated rows on bookings the org owns", async () => {
  const rows = await readOrgPendingRequests("o1");

  const owned = orgOwnedAppointmentWhere("o1");
  const [{ where }] = consultationFindMany.mock.calls[0];
  expect(where.OR).toEqual([
    { status: "PENDING", appointment: owned },
    {
      status: "APPROVED",
      appointment: {
        ...owned,
        occurrences: { none: expect.objectContaining({ isTentative: false }) },
        // Only the org's own money makes an approved row allocatable by it.
        payment: {
          some: expect.objectContaining({
            organizationId: "o1",
            paymentMethod: { in: ["WALLET", "INVOICE", "LICENSE"] },
          }),
        },
      },
    },
  ]);
  expect(
    Object.fromEntries(rows.map((r) => [r.id, r.awaitingExpertApproval])),
  ).toEqual({ pending: true, approved: false });
});

it("sizes a pick from the booked session, not a plan edited since", async () => {
  consultationFindMany.mockResolvedValue([
    {
      ...row("approved", "APPROVED"),
      appointment: {
        id: "appt-approved",
        occurrences: [
          {
            startsAt: new Date("2026-10-05T09:00:00Z"),
            endsAt: new Date("2026-10-05T10:00:00Z"),
            deletedAt: null,
            completionStatus: "RESCHEDULED",
          },
        ],
      },
      consultationPlan: {
        ...row("x", "APPROVED").consultationPlan,
        durationInHours: 2,
      },
    },
  ]);
  const [approved] = await readOrgPendingRequests("o1");
  expect(approved.sessionMinutes).toBe(60);
});

it("offers Allocate only on the approved row", async () => {
  const rows = await readOrgPendingRequests("o1");
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<PayerRequestsView orgId="o1" requests={rows} />));

  const allocateIds = Array.from(host.querySelectorAll("[data-allocate]")).map(
    (b) => b.getAttribute("data-allocate"),
  );
  // The table renders a desktop and a mobile layout, so ids repeat per layout.
  expect(new Set(allocateIds)).toEqual(new Set(["appt-approved"]));
  expect(host.textContent).toContain("Awaiting expert approval");
  act(() => root.unmount());
});
