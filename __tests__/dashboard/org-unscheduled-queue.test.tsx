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
import { PayerRequestsView } from "../../app/dashboard/organization/[orgId]/appointments/PayerRequestsView";

const row = (id: string, status: string) => ({
  id,
  status,
  requestedAt: new Date("2026-10-01T00:00:00Z"),
  appointment: { id: `appt-${id}` },
  consultationPlan: {
    title: "Plan",
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

it("reads PENDING and APPROVED-unallocated rows under the same org pin", async () => {
  const rows = await readOrgPendingRequests("o1");

  const [{ where }] = consultationFindMany.mock.calls[0];
  expect(where.OR).toEqual([
    { status: "PENDING", appointment: { organizationId: "o1" } },
    {
      status: "APPROVED",
      appointment: {
        organizationId: "o1",
        occurrences: { none: expect.objectContaining({ isTentative: false }) },
      },
    },
  ]);
  expect(
    Object.fromEntries(rows.map((r) => [r.id, r.awaitingExpertApproval])),
  ).toEqual({ pending: true, approved: false });
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
