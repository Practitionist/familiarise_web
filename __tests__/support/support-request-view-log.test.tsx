import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  removal: [],
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
  expect(screen.getAllByText(/^Our team will reply/)).toHaveLength(2);
  qc.clear();
});

it("drops the reply-by line once the team has replied", () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(supportKeys.ownCase("case-1"), {
    key: "c_case-1",
    caseId: "case-1",
    appointmentId: null,
    canReply: false,
    subject: "Session problem",
    reference: "SR-1",
    topic: "session",
    status: "IN_PROGRESS",
    ackDueAt: "2026-10-20T13:00:00.000Z",
    acknowledgedAt: "2026-10-20T12:30:00.000Z",
    createdAt: "2026-10-20T12:00:00.000Z",
    payment: null,
    organization: null,
    timeline: [],
  });
  render(
    <QueryClientProvider client={qc}>
      <SupportRequestView
        caseKey="c_case-1"
        requestsHref="/dashboard/consultee/p1/support"
        articles={articles}
      />
    </QueryClientProvider>,
  );
  expect(screen.queryByText(/^Our team/)).not.toBeInTheDocument();
  qc.clear();
});

describe("a resolved request", () => {
  const resolvedCase = {
    key: "c_case-1",
    caseId: "case-1",
    appointmentId: null,
    canReply: true,
    subject: "Session problem",
    reference: "SR-1",
    topic: "session",
    status: "RESOLVED",
    resolvedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    createdAt: "2026-10-20T12:00:00.000Z",
    payment: null,
    organization: null,
    timeline: [],
  };
  const resolution = (decisions: unknown[]) => ({
    decisions,
    recommendations: [],
    holds: [],
    evidenceRequests: [],
    recipients: [],
    canManage: false,
    canExecuteMoney: false,
    canManageHolds: false,
    canVoidRecommendations: false,
    refundLimitPaise: null,
    ownershipScope: "PERSONAL",
    updatedAt: "2026-10-20T12:00:00.000Z",
    caseKind: "INCIDENT",
    isAppeal: false,
    legalHoldAt: null,
    isAdmin: false,
  });
  function renderResolved(
    decisions: unknown[],
    overrides: Record<string, unknown> = {},
  ) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    qc.setQueryData(supportKeys.ownCase("case-1"), resolvedCase);
    qc.setQueryData(supportKeys.resolution("case-1"), {
      ...resolution(decisions),
      ...overrides,
    });
    render(
      <QueryClientProvider client={qc}>
        <SupportRequestView
          caseKey="c_case-1"
          requestsHref="/dashboard/consultee/p1/support"
          articles={articles}
        />
      </QueryClientProvider>,
    );
    return qc;
  }

  it("says a reply won't reopen it and reopens only on This didn't fix it", async () => {
    const qc = renderResolved([]);
    expect(screen.getByText(/Your reply won't reopen it/)).toBeInTheDocument();
    expect(screen.queryByText(/^Our team/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Replying reopens it/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "This didn't fix it" }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/support/cases/case-1/messages",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = (global.fetch as jest.Mock).mock.calls.find(
      ([url]) => url === "/api/support/cases/case-1/messages",
    );
    expect(JSON.parse(call[1].body)).toMatchObject({
      body: "This didn't fix my problem.",
      reopen: true,
    });
    qc.clear();
  });

  it("offers only the appeal once a decision is recorded", () => {
    const qc = renderResolved([
      {
        id: "dec_1",
        outcome: "NO_REMEDY",
        explanation: "Delivered as booked.",
        createdAt: "2026-10-20T12:00:00.000Z",
        appealUntil: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        supersedesDecisionId: null,
      },
    ]);
    expect(
      screen.queryByRole("button", { name: "This didn't fix it" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Appeal by / })).toHaveAttribute(
      "href",
      "#support-case-resolution",
    );
    qc.clear();
  });

  it("offers no further appeal on a decision that already decides an appeal", () => {
    const qc = renderResolved(
      [
        {
          id: "dec_appeal",
          outcome: "UPHELD",
          explanation: "The original decision stands.",
          createdAt: "2026-10-20T12:00:00.000Z",
          appealUntil: new Date(Date.now() + 3 * 86_400_000).toISOString(),
          supersedesDecisionId: null,
        },
      ],
      { isAppeal: true },
    );
    expect(
      screen.queryByRole("link", { name: /^Appeal by / }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "This didn't fix it" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Appeal this decision" }),
    ).not.toBeInTheDocument();
    qc.clear();
  });
});
