/**
 * The demand banner's placement line states a deadline only while it is
 * ahead; past it, the line says the first plan is overdue.
 */
import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExpertDemand } from "@/schemas/expert-demand";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));
const demand: { data: ExpertDemand | undefined } = { data: undefined };
jest.mock(
  "../../app/dashboard/consultant/[consultantId]/(features)/settings/use-expert-demand",
  () => ({
    expertDemandQueryKey: (id: string) => ["consultant-demand", id],
    useExpertDemand: () => ({ data: demand.data }),
  }),
);
jest.mock(
  "../../app/dashboard/consultant/[consultantId]/(features)/settings/use-save-booking-request-settings",
  () => ({
    useSaveBookingRequestSettings: () => ({
      isPending: false,
      mutate: jest.fn(),
    }),
  }),
);

import { DemandBanner } from "@/app/dashboard/consultant/[consultantId]/(features)/requests/DemandBanner";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

// Captured 11 Nov 15:17 UTC; the 48-hour deadline is Fri 13 Nov, 8:47 PM IST.
const CAPTURED = "2026-11-11T15:17:00.000Z";
const DEADLINE = "2026-11-13T15:17:00.000Z";

function renderAt(nowIso: string) {
  jest.setSystemTime(new Date(nowIso));
  demand.data = {
    acceptingRequests: true,
    bookingMode: "REQUEST",
    openRequests: 0,
    maxOpenRequests: null,
    nearestRequestExpiry: null,
    unplacedPlans: 2,
    oldestUnplacedPaidAt: CAPTURED,
    nearestPlacementDeadline: DEADLINE,
    bookedShare: null,
    learnersWaiting: 0,
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DisplayZoneProvider zone="Asia/Kolkata">
        <DemandBanner consultantId="cp-1" />
      </DisplayZoneProvider>
    </QueryClientProvider>,
  );
  return screen.getByRole("region", { name: "You're in demand" }).textContent;
}

describe("the demand banner's placement deadline", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("names the deadline while it is ahead", () => {
    expect(renderAt("2026-11-12T18:00:00.000Z")).toContain(
      "2 paid plans are waiting for times; place the first by Fri 13 Nov, 8:47 PM.",
    );
  });

  it("says the first plan is overdue once the deadline has passed", () => {
    const text = renderAt("2026-11-19T02:00:00.000Z");
    expect(text).toContain(
      "2 paid plans are waiting for times; the first was due by Fri 13 Nov, 8:47 PM. Place it now.",
    );
    expect(text).not.toContain("place the first by");
  });

  it("turns overdue in an open tab when the deadline passes", () => {
    expect(renderAt("2026-11-13T15:16:50.000Z")).toContain(
      "place the first by",
    );
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(
      screen.getByRole("region", { name: "You're in demand" }).textContent,
    ).toContain("the first was due by Fri 13 Nov, 8:47 PM. Place it now.");
  });
});
