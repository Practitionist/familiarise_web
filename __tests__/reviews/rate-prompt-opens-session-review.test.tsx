/**
 * A learner's Home "Rate" prompt opens the session's own review form in the
 * dashboard, so it works whether or not the expert's public profile is live.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReviewableSession } from "@/lib/reviews";

const mockSessionUser: Record<string, unknown> = {
  id: "u_daniel",
  role: "CONSULTEE",
  timezone: "Asia/Kolkata",
  consulteeProfileId: "ce_daniel",
  consultantProfileId: null,
  organizationMemberships: [],
};
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({}),
  usePathname: () => "/dashboard/consultee/ce_daniel/home",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: mockSessionUser }, isPending: false }),
}));

import HomeTab from "../../app/dashboard/consultee/[consulteeId]/(features)/home/HomeTab";

// The reviewable-sessions route's row for a held session with an expert whose profile is not public.
const reviewable: ReviewableSession = {
  appointmentId: "appt_held",
  consultantProfileId: "cp_pending_verification",
  consultantName: "Michael Anderson",
  track: "ONE_TO_ONE",
  ratingUnitId: null,
  appointmentType: "CONSULTATION",
  title: "Career consultation",
  heldAt: new Date("2026-11-10T05:30:00.000Z"),
  reviewed: false,
  existingReview: null,
};

const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: [] }),
  });
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("learner Home rate prompt", () => {
  it("links Rate to the session's review form, not the expert's public profile", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    qc.setQueryData(
      ["reviewable-sessions"],
      JSON.parse(JSON.stringify([reviewable])),
    );
    render(
      <QueryClientProvider client={qc}>
        <HomeTab
          learner={{ userId: "u_daniel", name: "Daniel Brown", image: null }}
          viewerOwnsProfile
          eventsData={{
            consultations: [],
            subscriptions: [],
            webinars: [],
            classes: [],
            trials: [],
          }}
          consulteeId="ce_daniel"
          viewerZone={{ zone: "Asia/Kolkata", own: true }}
        />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText("How was your session with Michael Anderson?"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /How was your session with Michael/ }),
    ).toHaveAttribute(
      "href",
      "/dashboard/consultee/ce_daniel/appointments/appt_held#review",
    );
  });
});
