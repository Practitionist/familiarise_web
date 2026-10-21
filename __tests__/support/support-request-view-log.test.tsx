import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { SupportRequestView } from "../../components/dashboard/shared/support/SupportRequestView";
import { supportKeys } from "../../lib/support/support-keys";

const articles = {
  payments: [],
  cancellation: [],
  scheduling: [],
  session: [],
  technical: [],
  recordings: [],
  documents: [],
  account: [],
  organisation: [],
  other: [],
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

it("renders the customer request thread as a labelled log, with booking context", () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(supportKeys.ownCase("case-1"), {
    key: "c_case-1",
    caseId: "case-1",
    appointmentId: "appt-1",
    canReply: false,
    subject: "Session problem",
    reference: "SR-1",
    topic: "session",
    status: "OPEN",
    createdAt: "2026-10-20T12:00:00.000Z",
    payment: null,
    organization: null,
    timeline: [
      {
        id: "m1",
        author: "USER",
        authorName: null,
        body: "The expert never joined",
        internal: false,
        at: "2026-10-20T12:00:00.000Z",
      },
    ],
  });
  render(
    <QueryClientProvider client={qc}>
      <SupportRequestView
        caseKey="c_case-1"
        requestsHref="/dashboard/consultee/p1/support"
        appointmentsBase="/dashboard/consultee/p1/appointments"
        articles={articles}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("log", { name: "Conversation" })).toHaveTextContent(
    "The expert never joined",
  );
  expect(screen.getByRole("link", { name: "Go to booking" })).toHaveAttribute(
    "href",
    "/dashboard/consultee/p1/appointments/appt-1",
  );
  qc.clear();
});
