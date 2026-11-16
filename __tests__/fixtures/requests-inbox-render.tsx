/** Rendering the Requests inbox over the shared fixture, for the render tests. */
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import prisma from "@/lib/prisma";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import {
  inboxQueryKey,
  type RequestsInboxPayload,
} from "@/lib/dashboard/requests-inbox-state";
import { RequestsInbox } from "@/components/dashboard/shared/requests/RequestsInbox";
import { CP, NOW, serveInboxFixture } from "./requests-inbox";

type MockPrisma = Parameters<typeof serveInboxFixture>[0];

/** Rows and dialogs pick their desktop shape from a media query. */
export function stubDesktopMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

/** The consultation tab's payload as the route serialises it; needs `lib/prisma` mocked. */
export async function readInboxPayload(): Promise<RequestsInboxPayload> {
  serveInboxFixture(prisma as unknown as MockPrisma);
  return JSON.parse(
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
}

/** Mount the inbox with `payload` already cached for the default consultation tab. */
export function mountInbox(payload: RequestsInboxPayload, staleTime = 0): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime } },
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
