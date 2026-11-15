/**
 * The inbox's chip set is one "Show" menu on the sort/Refresh row: a pick
 * writes `?chip=`, All clears it, and hovering an option prefetches its list.
 */

jest.mock("@/lib/payments/payouts/clawback-notifications", () => ({
  stageClawbackNotice: jest.fn(),
  stageRaisedClawback: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: jest.fn(), count: jest.fn() },
    subscription: { findMany: jest.fn(), count: jest.fn() },
    trial: { findMany: jest.fn(), count: jest.fn() },
    membership: { findMany: jest.fn() },
  },
}));
jest.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/consultant/cp-1/requests",
  useSearchParams: () => new URLSearchParams("type=consultation"),
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
  }),
}));
jest.mock("../../lib/auth-client", () => ({
  authClient: {},
  useSession: () => ({ data: null, isPending: false }),
}));
jest.mock("../../lib/time/use-viewer-zone", () => ({
  useViewerZone: () => ({ zone: "Asia/Kolkata", own: true }),
}));
jest.mock("../../components/ui/use-toast", () => ({
  toast: jest.fn(),
  useToast: () => ({ toast: jest.fn(), toasts: [] }),
}));

import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import prisma from "@/lib/prisma";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import {
  inboxQueryKey,
  type RequestsInboxPayload,
} from "@/lib/dashboard/requests-inbox-state";
import { RequestsInbox } from "@/components/dashboard/shared/requests/RequestsInbox";
import { CP, NOW, serveInboxFixture } from "../fixtures/requests-inbox";

type MockPrisma = Parameters<typeof serveInboxFixture>[0];
let payload: RequestsInboxPayload;
const fetchMock = jest.fn();

beforeAll(async () => {
  // Rows pick a desktop or sheet shape from a media query.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  serveInboxFixture(prisma as unknown as MockPrisma);
  payload = JSON.parse(
    JSON.stringify(
      await readRequestsInbox({
        consultantProfileId: CP,
        type: "consultation",
        sort: "priority",
        page: 1,
        now: NOW,
      }),
    ),
  );
});

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, advanceTimers: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }));
  globalThis.fetch = fetchMock;
  window.history.replaceState(null, "", "/?type=consultation");
});

afterEach(() => {
  jest.useRealTimers();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    inboxQueryKey({
      consultantProfileId: CP,
      scope: "personal",
      type: "consultation",
      chip: null,
      sort: "priority",
      page: 1,
      after: null,
      focus: null,
    }),
    payload,
  );
  render(
    <QueryClientProvider client={client}>
      <RequestsInbox consultantProfileId={CP} viewerZone="Asia/Kolkata" />
    </QueryClientProvider>,
  );
}

describe("Requests inbox Show menu", () => {
  it("offers the tab's chips and writes the pick to ?chip=", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Show: All" }));
    const group = screen.getByRole("group", { name: "Show" });
    expect(
      Array.from(group.querySelectorAll("button")).map((b) => b.textContent),
    ).toEqual(["All", "Answer today", "Awaiting payment", "Declined"]);

    fireEvent.click(screen.getByRole("button", { name: /Awaiting payment/ }));
    expect(new URLSearchParams(window.location.search).get("chip")).toBe(
      "awaiting-payment",
    );
  });

  it("prefetches the hovered option's list", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Show: All" }));
    fireEvent.pointerEnter(screen.getByRole("button", { name: /Declined/ }));
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.includes("chip=declined"))).toBe(true);
  });
});
