/**
 * Operator view reads nothing that belongs to the signed-in operator: no owner
 * action items from a cached owner read, no self-only Account or Notifications
 * form, no owner-only expert queries, and every time names its zone.
 */

import * as React from "react";
import { render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockSessionUser: Record<string, unknown> = {
  id: "u_operator",
  role: "STAFF",
  timezone: "Pacific/Tarawa",
  consulteeProfileId: null,
  consultantProfileId: null,
  organizationMemberships: [],
};
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({}),
  usePathname: () => "/dashboard/consultee/cp_learner/home",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: mockSessionUser }, isPending: false }),
}));
jest.mock("../../lib/auth-server", () => ({
  getSession: async () => ({ user: mockSessionUser }),
}));
jest.mock("../../components/dashboard/account", () => ({
  AccountSettings: () => <p>operator account form</p>,
}));

import HomeTab from "../../app/dashboard/consultee/[consulteeId]/(features)/home/HomeTab";
import ConsulteeAccountPage from "../../app/dashboard/consultee/[consulteeId]/(features)/settings/account/page";
import ConsultantAccountPage from "../../app/dashboard/consultant/[consultantId]/(features)/settings/account/page";
import { useExpertDemand } from "../../app/dashboard/consultant/[consultantId]/(features)/settings/use-expert-demand";
import { useExpertShareHref } from "../../hooks/useExpertShareHref";
import { getPersonalViewerZone } from "../../lib/time/viewer-zone-server";
import { formatForViewer } from "../../lib/time/viewer-zone";
import type { TConsulteeEventsResponse } from "../../types/consultee-events";

const EMPTY_EVENTS: TConsulteeEventsResponse = {
  consultations: [],
  subscriptions: [],
  webinars: [],
  classes: [],
  trials: [],
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

const wrapper = (qc: QueryClient) =>
  function Wrapper({ children }: Readonly<{ children: React.ReactNode }>) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

describe("learner Home in operator view", () => {
  it("ignores the operator's own cached rating prompts and removal cases", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    qc.setQueryData(
      ["reviewable-sessions"],
      [
        {
          appointmentId: "a_own",
          consultantProfileId: "cp_x",
          consultantName: "Grace Anderson",
          existingReview: null,
        },
      ],
    );
    qc.setQueryData(
      ["support-requests", "session", "home"],
      [
        {
          id: "case_own",
          category: "CONDUCT_REMOVAL",
          status: "OPEN",
          appointment: { planTitle: "Own seat" },
        },
      ],
    );
    render(
      <QueryClientProvider client={qc}>
        <HomeTab
          learner={{
            userId: "u_learner",
            name: "Samantha Anderson",
            image: null,
          }}
          viewerOwnsProfile={false}
          eventsData={EMPTY_EVENTS}
          consulteeId="cp_learner"
          viewerZone={{ zone: "Pacific/Tarawa", own: false }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Samantha Anderson's home")).toBeInTheDocument();
    expect(screen.queryByText(/How was your session/)).toBeNull();
    expect(screen.queryByText(/reviewing your removal/)).toBeNull();
  });
});

describe("self-only settings in operator view", () => {
  it.each([
    [
      "learner",
      () =>
        ConsulteeAccountPage({
          params: Promise.resolve({ consulteeId: "cp_learner" }),
        }),
    ],
    [
      "expert",
      () =>
        ConsultantAccountPage({
          params: Promise.resolve({ consultantId: "cp_expert" }),
        }),
    ],
  ] as const)(
    "shows the %s's Account section as owner-only, never the operator's form",
    async (owner, page) => {
      render(await page());
      expect(
        screen.getByText(
          `Only the ${owner} can see and change these settings.`,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("operator account form")).toBeNull();
    },
  );
});

describe("expert pages in operator view", () => {
  it("asks for neither the share link nor the booking load", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const share = renderHook(() => useExpertShareHref("cp_expert"), {
      wrapper: wrapper(qc),
    });
    const demand = renderHook(() => useExpertDemand("cp_expert"), {
      wrapper: wrapper(qc),
    });
    expect(share.result.current).toBe("/explore/experts/cp_expert");
    expect(demand.result.current.fetchStatus).toBe("idle");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("times in operator view", () => {
  it("names the zone on someone else's dashboard and stays unlabelled for the owner", async () => {
    // 03:30 UTC on 23 Nov 2026 is 3:30 pm in Tarawa (UTC+12).
    const at = "2026-11-23T03:30:00.000Z";
    const inspecting = await getPersonalViewerZone("consultee", "cp_learner");
    expect(inspecting).toEqual({ zone: "Pacific/Tarawa", own: false });
    expect(formatForViewer(at, inspecting, "EEE, d MMM · h:mm a")).toMatch(
      /^Mon, 23 Nov · 3:30 PM \S+$/,
    );
    mockSessionUser.consulteeProfileId = "cp_learner";
    const owner = await getPersonalViewerZone("consultee", "cp_learner");
    expect(owner.own).toBe(true);
    mockSessionUser.consulteeProfileId = null;
  });
});
