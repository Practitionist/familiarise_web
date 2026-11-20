/**
 * @jest-environment jsdom
 */

// Home's "requests to answer" count, its Requests card and the tab its links
// open read one set: a paid plan still waiting for times is counted, listed and
// landed on.

// The reads reach payout setup, whose clawback notices load the email stack (unloadable in jsdom).
jest.mock("@/lib/payments/payouts/clawback-notifications", () =>
  jest
    .requireActual("../fixtures/requests-inbox-mocks")
    .clawbackNoticesModule(),
);
jest.mock("../../lib/prisma", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").inboxPrismaModule(),
);
jest.mock("next/navigation", () => ({ useParams: () => ({}) }));
jest.mock("../../lib/auth-client", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").signedOutAuthModule(),
);

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

import prisma from "@/lib/prisma";
import { countRequestsToAnswer } from "@/lib/data/needs-you";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import {
  isInboxType,
  landingInboxType,
  readInboxParams,
} from "@/lib/dashboard/requests-inbox-state";
import { RequestsInboxPreview } from "@/components/dashboard/shared/requests/RequestsInboxPreview";
import {
  CP,
  NOW,
  paidUnallocatedSubscription,
  serve,
} from "../fixtures/requests-inbox";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

beforeEach(() => {
  const models = {
    consultation: serve([]),
    subscription: serve([paidUnallocatedSubscription]),
    trial: serve([]),
  };
  for (const [model, rows] of Object.entries(models)) {
    db[model].findMany.mockImplementation(rows.findMany);
    db[model].count.mockImplementation(rows.count);
  }
  db.membership.findMany.mockResolvedValue([]);
  // The inbox route's body for each tab, as the real read serialises it.
  global.fetch = jest.fn(async (url: string) => {
    const type = new URL(url, "http://test").searchParams.get("type");
    if (!isInboxType(type)) throw new Error(`unexpected tab ${type}`);
    const payload = await readRequestsInbox({
      consultantProfileId: CP,
      type,
      sort: "priority",
      page: 1,
      now: NOW,
    });
    const body = JSON.parse(JSON.stringify(payload));
    return { ok: true, json: async () => body };
  }) as unknown as typeof fetch;
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

it("lists the paid plan the Home count includes", async () => {
  expect(await countRequestsToAnswer({ consultantProfileId: CP })).toBe(1);

  renderWithQueries(<RequestsInboxPreview consultantProfileId={CP} />);

  // Two reads in a row: the subscription tab waits on the consultation counts.
  await waitFor(
    () => expect(screen.queryByText("Loading requests")).toBeNull(),
    { timeout: 8000 },
  );
  expect(screen.queryByText("No pending requests")).toBeNull();
  expect(screen.getByText(/Weekly coaching/)).toBeTruthy();
}, 10_000);

describe("the tab Home's Review and the sidebar badge open", () => {
  const noParams = () => null;

  it("is the first tab holding the counted rows", async () => {
    const { meta } = await readRequestsInbox({
      consultantProfileId: CP,
      type: "consultation",
      sort: "priority",
      page: 1,
      now: NOW,
    });
    const landing = landingInboxType(meta.counts);
    expect(landing).toBe("subscription");
    expect(readInboxParams(noParams, landing).type).toBe("subscription");
  });

  it("stays on Consultations when it has rows or nothing has any, and a named tab wins", () => {
    expect(
      landingInboxType({ consultation: 1, subscription: 2, trial: 0 }),
    ).toBe("consultation");
    expect(
      landingInboxType({ consultation: 0, subscription: 0, trial: 0 }),
    ).toBe("consultation");
    expect(
      landingInboxType({ consultation: 0, subscription: 0, trial: 3 }),
    ).toBe("trial");
    expect(
      readInboxParams(
        (key) => (key === "type" ? "consultation" : null),
        "subscription",
      ).type,
    ).toBe("consultation");
  });
});

it("a malformed inbox body shows Retry, not a broken card", async () => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ rows: "not a list" }),
  })) as unknown as typeof fetch;

  renderWithQueries(<RequestsInboxPreview consultantProfileId={CP} />);

  expect(
    await screen.findByText("Requests could not be read.", undefined, {
      timeout: 5000,
    }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});
