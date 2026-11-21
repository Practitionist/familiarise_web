/**
 * Display rules found in release QA: an unverified expert's Home offers no
 * share link that would 404, the organisation catalog's "Delivered by" picker
 * labels and blocks unverified experts, and a learner's Home in operator view
 * never claims "All caught up" for items the operator cannot read.
 */

import * as React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockSessionUser: Record<string, unknown> = {
  id: "u_expert",
  role: "CONSULTANT",
  timezone: "Asia/Kolkata",
  consulteeProfileId: null,
  consultantProfileId: "cp_expert",
  organizationMemberships: [],
};
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({}),
  usePathname: () => "/dashboard/organization/o1/catalog",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: mockSessionUser }, isPending: false }),
}));
jest.mock("../../lib/navigation/history", () => ({ replaceUrl: jest.fn() }));

const mockFindMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    membership: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    planMaterial: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    consultationPlan: { findMany: jest.fn().mockResolvedValue([]) },
    subscriptionPlan: { findMany: jest.fn().mockResolvedValue([]) },
    webinarPlan: { findMany: jest.fn().mockResolvedValue([]) },
    classPlan: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn().mockResolvedValue({ error: null }),
}));
jest.mock(
  "../../app/dashboard/organization/[orgId]/catalog/CatalogClient",
  () => ({
    CatalogClient: (props: { experts: unknown }) => (
      <pre data-testid="experts">{JSON.stringify(props.experts)}</pre>
    ),
  }),
);

import { ShareProfilePrompt } from "../../app/dashboard/consultant/[consultantId]/(features)/home/ThisMonthCard";
import HomeTab from "../../app/dashboard/consultee/[consulteeId]/(features)/home/HomeTab";
import OrgCatalogPage from "../../app/dashboard/organization/[orgId]/catalog/page";
import type { TConsulteeEventsResponse } from "../../types/consultee-events";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetch(verificationStatus: string | "pending") {
  global.fetch = jest.fn((url: string) => {
    if (url.includes("/api/verification/status")) {
      if (verificationStatus === "pending") return new Promise(() => {});
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { verificationStatus } }),
      });
    }
    // Every other read stays unanswered, so only the standing under test decides.
    return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
  }) as unknown as typeof fetch;
}

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("Share your page on an expert's Home", () => {
  const renderPrompt = () =>
    render(
      <QueryClientProvider client={client()}>
        <ShareProfilePrompt consultantId="cp_expert" />
      </QueryClientProvider>,
    );

  it("offers no link to an expert who is still under review, and says when the page goes live", async () => {
    mockFetch("UNDER_REVIEW");
    renderPrompt();
    expect(
      await screen.findByText(
        /page goes live for learners once you are verified/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Copy link")).toBeNull();
    expect(screen.queryByText("Open")).toBeNull();
  });

  it("offers Copy link and Open to a verified expert", async () => {
    mockFetch("VERIFIED");
    renderPrompt();
    expect(await screen.findByText("Copy link")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.queryByText(/once you are verified/)).toBeNull();
  });

  it("shows neither the links nor the note while the standing is unknown", () => {
    mockFetch("pending");
    renderPrompt();
    expect(screen.queryByText("Copy link")).toBeNull();
    expect(screen.queryByText("Open")).toBeNull();
    expect(screen.queryByText(/once you are verified/)).toBeNull();
  });
});

describe("organisation catalog experts", () => {
  it("hands the client only a boolean for each member's verification", async () => {
    mockFindMany.mockResolvedValue([
      {
        consultantProfileId: "cp_a",
        consultantProfile: { verificationStatus: "VERIFIED" },
        user: { name: "Ananya Anderson", email: "a@example.com" },
      },
      {
        consultantProfileId: "cp_b",
        consultantProfile: { verificationStatus: "UNDER_REVIEW" },
        user: { name: null, email: "b@example.com" },
      },
    ]);
    render(await OrgCatalogPage({ params: Promise.resolve({ orgId: "o1" }) }));
    expect(JSON.parse(screen.getByTestId("experts").textContent ?? "")).toEqual(
      [
        {
          consultantProfileId: "cp_a",
          name: "Ananya Anderson",
          isVerified: true,
        },
        {
          consultantProfileId: "cp_b",
          name: "b@example.com",
          isVerified: false,
        },
      ],
    );
  });
});

describe("Delivered by picker", () => {
  it("labels an unverified expert and will not let it be picked", async () => {
    const { CatalogClient } = jest.requireActual(
      "../../app/dashboard/organization/[orgId]/catalog/CatalogClient",
    ) as typeof import("../../app/dashboard/organization/[orgId]/catalog/CatalogClient");
    window.HTMLElement.prototype.hasPointerCapture = jest.fn();
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
    mockFetch("VERIFIED");
    render(
      <QueryClientProvider client={client()}>
        <CatalogClient
          orgId="o1"
          experts={[
            { consultantProfileId: "cp_a", name: "Ananya", isVerified: true },
            { consultantProfileId: "cp_b", name: "Alex", isVerified: false },
          ]}
          materials={[]}
          materialsTotal={0}
          orgPlans={[]}
        />
      </QueryClientProvider>,
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    const options = await screen.findAllByRole("option");
    const alex = options.find((o) => o.textContent?.includes("Alex"));
    expect(alex?.textContent).toContain("Waiting for verification");
    expect(alex).toHaveAttribute("aria-disabled", "true");
    const ananya = options.find((o) => o.textContent?.includes("Ananya"));
    expect(ananya?.textContent).not.toContain("Waiting for verification");
    expect(ananya).not.toHaveAttribute("aria-disabled", "true");
  });

  it("does not preselect a lone unverified expert", () => {
    const { CatalogClient } = jest.requireActual(
      "../../app/dashboard/organization/[orgId]/catalog/CatalogClient",
    ) as typeof import("../../app/dashboard/organization/[orgId]/catalog/CatalogClient");
    mockFetch("VERIFIED");
    render(
      <QueryClientProvider client={client()}>
        <CatalogClient
          orgId="o1"
          experts={[
            { consultantProfileId: "cp_b", name: "Alex", isVerified: false },
          ]}
          materials={[]}
          materialsTotal={0}
          orgPlans={[]}
        />
      </QueryClientProvider>,
    );
    expect(within(screen.getByRole("combobox")).queryByText("Alex")).toBeNull();
    expect(screen.getByText(/No expert is verified yet/)).toBeInTheDocument();
  });
});

const EMPTY_EVENTS: TConsulteeEventsResponse = {
  consultations: [],
  subscriptions: [],
  webinars: [],
  classes: [],
  trials: [],
};

describe("learner Home empty state", () => {
  const renderHome = (viewerOwnsProfile: boolean) =>
    render(
      <QueryClientProvider client={client()}>
        <HomeTab
          learner={{ userId: "u_learner", name: "Daniel Brown", image: null }}
          viewerOwnsProfile={viewerOwnsProfile}
          eventsData={EMPTY_EVENTS}
          consulteeId="cp_learner"
          viewerZone={{ zone: "Asia/Kolkata", own: viewerOwnsProfile }}
        />
      </QueryClientProvider>,
    );

  it("tells the learner they are caught up", async () => {
    mockFetch("VERIFIED");
    renderHome(true);
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });

  it("never says the learner is caught up in operator view", async () => {
    mockFetch("VERIFIED");
    renderHome(false);
    expect(
      await screen.findByText(/Items only Daniel Brown can see/),
    ).toBeInTheDocument();
    expect(screen.queryByText("All caught up")).toBeNull();
    expect(screen.queryByText(/waiting on you/)).toBeNull();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });
});
