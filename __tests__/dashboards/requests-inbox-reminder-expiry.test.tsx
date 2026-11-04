/**
 * An inbox left open across the end of a pay window: the row's Remind leaves
 * at the window's own instant, without waiting for a refetch or another render
 * from the page.
 */

const mockSubscription = { findMany: jest.fn(), count: jest.fn() };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: jest.fn(), count: jest.fn() },
    subscription: {
      findMany: (...args: unknown[]) => mockSubscription.findMany(...args),
      count: (...args: unknown[]) => mockSubscription.count(...args),
    },
    trial: { findMany: jest.fn(), count: jest.fn() },
  },
}));
jest.mock("../../hooks/use-media-query", () => ({
  useIsDesktop: () => true,
}));

import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import { InboxRow } from "@/components/dashboard/shared/requests/InboxRow";
import { toStampDate } from "@/lib/dashboard/requests-inbox-state";
import {
  CP,
  NOW,
  awaitingSubscription,
  serve,
} from "../fixtures/requests-inbox";

afterEach(() => {
  jest.useRealTimers();
});

it("drops Remind when the pay window closes while the inbox stays open", async () => {
  const served = serve([awaitingSubscription]);
  mockSubscription.findMany.mockImplementation(served.findMany);
  mockSubscription.count.mockImplementation(served.count);
  const { rows } = await readRequestsInbox({
    consultantProfileId: CP,
    type: "subscription",
    sort: "priority",
    page: 1,
    now: NOW,
  });
  const row = rows[0];
  expect(row.reminderExpiresAt).not.toBeNull();
  const closesAt = toStampDate(row.reminderExpiresAt ?? NOW).getTime();

  jest.useFakeTimers({ now: closesAt - 60_000 });
  render(
    <InboxRow
      row={row}
      viewer={{ zone: "Asia/Kolkata", own: true }}
      selectable={false}
      selected={false}
      busy={false}
      onSelect={() => undefined}
      onAction={() => undefined}
    />,
  );
  expect(screen.queryAllByRole("button", { name: "Remind" })).not.toHaveLength(
    0,
  );

  act(() => {
    jest.advanceTimersByTime(60_000 + 1_000);
  });
  expect(screen.queryAllByRole("button", { name: "Remind" })).toHaveLength(0);
});
