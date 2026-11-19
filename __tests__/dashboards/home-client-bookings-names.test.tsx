/**
 * Each "Booked as a client" row opens with a name that says which session it
 * opens, and the visible "Open" stays inside that name.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({}),
  usePathname: () => "/dashboard/consultant/cp-1/home",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));
jest.mock("../../hooks/scheduling/useLazyJoinMeeting", () => ({
  useLazyJoinMeeting: () => jest.fn(),
}));

import { HomeTab } from "@/app/dashboard/consultant/[consultantId]/(features)/home/HomeTab";
import type { TConsultantClientBooking } from "@/types/consultant-events";

const booking = (
  id: string,
  expertName: string,
  startsAt: string,
): TConsultantClientBooking => ({
  occurrenceId: id,
  appointmentId: `appt-${id}`,
  startsAt,
  endsAt: null,
  expertName,
  href: `/dashboard/consultee/ce-1/appointments/appt-${id}`,
});

it("names each Open button by its expert and date", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HomeTab
        appointments={[]}
        consultantId="cp-1"
        payoutSetup={undefined}
        viewerZone={{ zone: "Asia/Kolkata", own: true }}
        clientBookings={[
          booking("o1", "Meera Iyer", "2026-11-20T10:30:00.000Z"),
          booking("o2", "Rahul Verma", "2026-11-21T04:00:00.000Z"),
        ]}
      />
    </QueryClientProvider>,
  );
  const links = screen.getAllByRole("link", { name: /^Open session with/ });
  expect(links.map((l) => l.getAttribute("aria-label"))).toEqual([
    "Open session with Meera Iyer, Fri, Nov 20, 4:00 PM",
    "Open session with Rahul Verma, Sat, Nov 21, 9:30 AM",
  ]);
  expect(links.map((l) => l.textContent)).toEqual(["Open", "Open"]);
  expect(links[0].getAttribute("href")).toBe(
    "/dashboard/consultee/ce-1/appointments/appt-o1",
  );
});
