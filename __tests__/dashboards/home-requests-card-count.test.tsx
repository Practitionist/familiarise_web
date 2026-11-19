/**
 * @jest-environment jsdom
 */

// Home's "requests to answer" count and its Requests card read one set: a paid
// plan still waiting for times is counted, so the card lists it too.

jest.mock("../../lib/prisma", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").inboxPrismaModule(),
);
jest.mock("next/navigation", () => ({ useParams: () => ({}) }));
jest.mock("../../lib/auth-client", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").signedOutAuthModule(),
);

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";

import prisma from "@/lib/prisma";
import { countRequestsToAnswer } from "@/lib/data/needs-you";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import { isInboxType } from "@/lib/dashboard/requests-inbox-state";
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
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
});

it("lists the paid plan the Home count includes", async () => {
  expect(await countRequestsToAnswer({ consultantProfileId: CP })).toBe(1);

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RequestsInboxPreview consultantProfileId={CP} />
    </QueryClientProvider>,
  );

  expect(await screen.findByText(/Weekly coaching/)).toBeTruthy();
  expect(screen.queryByText("No pending requests")).toBeNull();
});
