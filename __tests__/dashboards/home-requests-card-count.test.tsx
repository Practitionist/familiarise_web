/**
 * @jest-environment jsdom
 */

// Home's "requests to answer" count, its Requests card and the tab its links
// open read one set: the rows the expert must act on. A pay link waiting on
// its buyer is neither counted, listed on Home nor landed on.

// The reads reach payout setup, whose clawback notices load the email stack (unloadable in jsdom).
jest.mock("@/lib/payments/payouts/clawback-notifications", () =>
  jest
    .requireActual("../fixtures/requests-inbox-mocks")
    .clawbackNoticesModule(),
);
jest.mock("../../lib/prisma", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").inboxPrismaModule(),
);
jest.mock("next/navigation", () => ({
  ...jest
    .requireActual("../fixtures/requests-inbox-mocks")
    .inboxNavigationModule(),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
jest.mock("../../lib/auth-client", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").signedOutAuthModule(),
);
jest.mock("../../lib/auth/personal-dashboard-access", () => ({
  requirePersonalProfileAccess: async () => ({}),
}));
jest.mock("../../lib/time/viewer-zone-server", () => ({
  getViewerZone: async () => ({ zone: "Asia/Kolkata", own: true }),
  getPersonalViewerZone: async () => ({ zone: "Asia/Kolkata", own: true }),
}));

import {
  HydrationBoundary,
  QueryClient,
  QueryClientProvider,
  type DehydratedState,
} from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import {
  isValidElement,
  type JSXElementConstructor,
  type ReactElement,
  type ReactNode,
} from "react";

import prisma from "@/lib/prisma";
import { countRequestsToAnswer } from "@/lib/data/needs-you";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import {
  isInboxType,
  isRequestToAnswer,
  landingInboxType,
  nextInboxSearch,
  parseRequestsInboxPayload,
  readInboxParams,
  type InboxType,
  type RequestsInboxPayload,
} from "@/lib/dashboard/requests-inbox-state";
import RequestsPage from "@/app/dashboard/consultant/[consultantId]/(features)/requests/page";
import {
  RequestsInbox,
  type RequestsInboxProps,
} from "@/components/dashboard/shared/requests/RequestsInbox";
import { RequestsInboxPreview } from "@/components/dashboard/shared/requests/RequestsInboxPreview";
import {
  CP,
  NOW,
  awaitingConsultation,
  movingConsultation,
  paidUnallocatedSubscription,
  serve,
  serveInboxFixture,
} from "../fixtures/requests-inbox";
import { stubDesktopMatchMedia } from "../fixtures/requests-inbox-render";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

type Rows = Parameters<typeof serve>[0];

function serveRows(consultations: Rows, subscriptions: Rows) {
  const models = {
    consultation: serve(consultations),
    subscription: serve(subscriptions),
    trial: serve([]),
  };
  for (const [model, rows] of Object.entries(models)) {
    db[model].findMany.mockImplementation(rows.findMany);
    db[model].count.mockImplementation(rows.count);
  }
}

const readTab = async (type: InboxType): Promise<RequestsInboxPayload> =>
  JSON.parse(
    JSON.stringify(
      await readRequestsInbox({
        consultantProfileId: CP,
        type,
        sort: "priority",
        page: 1,
        now: NOW,
      }),
    ),
  );

/** The inbox route's 200 body for each tab, or `body` for every tab. */
function serveRoute(body?: unknown) {
  global.fetch = jest.fn(async (url: string) => {
    const type = new URL(url, "http://test").searchParams.get("type");
    if (!isInboxType(type)) throw new Error(`unexpected tab ${type}`);
    const json = body ?? (await readTab(type));
    return { ok: true, json: async () => json };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  serveRows([], [paidUnallocatedSubscription]);
  db.membership.findMany.mockResolvedValue([]);
  db.consultantProfile = {
    findUnique: jest.fn(async () => ({ acceptingRequests: true })),
  };
  serveRoute();
});

const renderWithQueries = (ui: ReactElement) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );

async function renderPreview() {
  renderWithQueries(<RequestsInboxPreview consultantProfileId={CP} />);
  // Two reads in a row: the subscription tab waits on the consultation counts.
  await waitFor(
    () => expect(screen.queryByText("Loading requests")).toBeNull(),
    { timeout: 8000 },
  );
}

/** The props of the first `type` element in a server component's tree. */
function propsOf<P>(node: ReactNode, type: JSXElementConstructor<P>): P | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = propsOf(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement<P & { children?: ReactNode }>(node)) return null;
  if (node.type === type) return node.props;
  return propsOf(node.props.children, type);
}

/** What a Requests URL without `type` shows: the tab passed down and the tabs seeded. */
async function openRequests(search: Record<string, string> = {}) {
  const tree = await RequestsPage({
    params: Promise.resolve({ consultantId: CP }),
    searchParams: Promise.resolve(search),
  });
  const inbox = propsOf<RequestsInboxProps>(tree, RequestsInbox);
  const seeded = propsOf<{ state: DehydratedState }>(tree, HydrationBoundary);
  return {
    landingType: inbox?.landingType,
    seededTabs: (seeded?.state.queries ?? []).map((q) => q.queryKey[3]),
  };
}

it("lists the paid plan the Home count includes", async () => {
  expect(await countRequestsToAnswer({ consultantProfileId: CP })).toBe(1);
  await renderPreview();
  expect(screen.queryByText("No requests to answer")).toBeNull();
  expect(screen.getByText(/Weekly coaching/)).toBeTruthy();
}, 10_000);

describe("a pay link waiting on its buyer beside an unplaced paid plan", () => {
  beforeEach(() =>
    serveRows([awaitingConsultation], [paidUnallocatedSubscription]),
  );

  it("is counted once, and Home lists only the plan", async () => {
    expect(await countRequestsToAnswer({ consultantProfileId: CP })).toBe(1);
    await renderPreview();
    expect(screen.getByText(/Weekly coaching/)).toBeTruthy();
    expect(screen.queryByText(/Career chat/)).toBeNull();
  }, 10_000);

  it("opens Subscriptions, the tab holding the counted row", async () => {
    const { landingType, seededTabs } = await openRequests();
    expect(landingType).toBe("subscription");
    expect(seededTabs).toEqual(["subscription"]);
  });

  it("still opens a tab the link names", async () => {
    expect((await openRequests({ type: "consultation" })).seededTabs).toEqual([
      "consultation",
    ]);
  });
});

it("leaves out the expert's own move with times, as the count does", async () => {
  serveRows(
    [
      movingConsultation("CONSULTANT", true),
      { ...movingConsultation("CONSULTEE", true), id: "c-learner-move" },
    ],
    [],
  );
  const { rows } = await readTab("consultation");
  expect(rows.filter(isRequestToAnswer).map((row) => row.id)).toEqual([
    "c-learner-move",
  ]);
});

describe("the tab a Requests link without `type` opens", () => {
  it("is the first tab with rows when nothing waits on the expert", async () => {
    serveRows([awaitingConsultation], []);
    expect(await countRequestsToAnswer({ consultantProfileId: CP })).toBe(0);
    expect((await openRequests()).landingType).toBe("consultation");
    expect(
      landingInboxType(
        { consultation: 0, subscription: 0 },
        (await readTab("consultation")).meta.counts,
      ),
    ).toBe("consultation");
    expect(
      landingInboxType(
        { consultation: 0, subscription: 0 },
        { consultation: 0, subscription: 0, trial: 3 },
      ),
    ).toBe("trial");
    expect(landingInboxType({ consultation: 1, subscription: 2 })).toBe(
      "consultation",
    );
  });

  it("keeps its filter after a reload once the counts change", () => {
    // Bare /requests landed on Subscriptions; the expert picks "Next cycle".
    const written = nextInboxSearch("", { chip: "next-cycle" }, "subscription");
    // A consultation arrives, so a bare link would now land on Consultations.
    const reloaded = readInboxParams(
      (key) => new URLSearchParams(written).get(key),
      landingInboxType({ consultation: 1, subscription: 1 }),
    );
    expect([reloaded.type, reloaded.chip]).toEqual([
      "subscription",
      "next-cycle",
    ]);
    // A tab the URL already names is left alone.
    expect(nextInboxSearch("type=trial", { sort: "new" }, "subscription")).toBe(
      "type=trial&sort=new",
    );
  });
});

describe("an inbox body the renderers cannot draw", () => {
  // Valid metadata around a row cut short.
  const truncated = async () => {
    const { meta } = await readTab("subscription");
    return { rows: [{ id: "r-1", kind: "consultation" }], meta };
  };

  it("is refused while every real row kind parses", async () => {
    const kinds = new Set<string>();
    const collect = async () => {
      for (const type of ["consultation", "subscription", "trial"] as const) {
        const { rows } = parseRequestsInboxPayload(await readTab(type));
        for (const row of rows) kinds.add(row.kind);
      }
    };
    await collect();
    serveInboxFixture(db as unknown as Parameters<typeof serveInboxFixture>[0]);
    await collect();
    expect([...kinds].sort()).toEqual([
      "consultation",
      "next-cycle",
      "subscription",
      "trial",
    ]);
    const body = await truncated();
    expect(() => parseRequestsInboxPayload(body)).toThrow(
      "Requests could not be read.",
    );
  });

  it("shows Retry on Home's card", async () => {
    serveRoute(await truncated());
    renderWithQueries(<RequestsInboxPreview consultantProfileId={CP} />);
    expect(
      await screen.findByText("Requests could not be read.", undefined, {
        timeout: 5000,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows Retry on the Requests page", async () => {
    stubDesktopMatchMedia();
    serveRoute(await truncated());
    renderWithQueries(
      <RequestsInbox consultantProfileId={CP} viewerZone="Asia/Kolkata" />,
    );
    expect(
      await screen.findByText("Requests could not be read.", undefined, {
        timeout: 5000,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
