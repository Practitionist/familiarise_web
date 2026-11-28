// Invariant: another open thread never hides a session's report. Beside it the
// conversation offers the report; with several ended sessions it asks which one,
// in the viewer's zone, and each choice opens that session's own report page.

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SessionConversation } from "@/components/dashboard/shared/support/SessionConversation";
import { sessionReportHref } from "@/lib/support/report-link";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

type ThreadState = Parameters<typeof SessionConversation>[0]["t"];

const payment = {
  id: "case-pay",
  status: "ESCALATED",
  activeChannel: "HUMAN",
  category: "PAYMENT_STATUS",
  currentNodeId: null,
  appointmentOccurrenceId: null,
  messages: [],
};

function threadState(over: Partial<ThreadState>): ThreadState {
  const base = {
    query: { isError: false, isFetching: false, refetch: jest.fn() },
    messages: [],
    history: {
      timeline: [],
      hasMore: false,
      loading: false,
      loadOlder: jest.fn(),
    },
    availableIntents: [
      { category: "NO_SHOW", label: "The expert didn't join" },
    ],
    options: [],
    thread: payment,
    isHuman: true,
    isResolved: false,
    isClosed: false,
    started: true,
    turnPending: false,
    submitTurn: jest.fn(() => true),
    failedTurns: {},
    retryTurn: jest.fn(),
    lastActions: [],
    waitingLine: "",
    handoffIndex: -1,
    occurrenceId: undefined,
    sessionReports: [],
    reportSessions: [
      {
        id: "occ-b",
        startsAt: "2026-11-23T04:30:00.000Z",
        endsAt: "2026-11-23T05:30:00.000Z",
      },
      {
        id: "occ-a",
        startsAt: "2026-11-16T04:30:00.000Z",
        endsAt: "2026-11-16T05:30:00.000Z",
      },
    ],
  };
  return { ...base, ...over } as unknown as ThreadState;
}

// The viewer's zone, as each customer dashboard's layout provides it.
const renderConversation = (t: ThreadState) =>
  render(
    <DisplayZoneProvider zone="Asia/Kolkata">
      <QueryClientProvider client={new QueryClient()}>
        <SessionConversation
          t={t}
          requestsHref="/dashboard/consultee/p1/support"
        />
      </QueryClientProvider>
    </DisplayZoneProvider>,
  );

it("offers the report beside an open human payment case and asks which session, linking each to its page", () => {
  renderConversation(threadState({}));
  fireEvent.click(
    screen.getByRole("button", { name: "Report a problem with a session" }),
  );
  expect(screen.getByText("Which session was it?")).toBeInTheDocument();
  const links = screen
    .getAllByRole("link")
    .map((a) => a.getAttribute("href"))
    .filter((href) => href?.includes("intent=NO_SHOW"));
  expect(links).toEqual([
    "?intent=NO_SHOW&occurrence=occ-b",
    "?intent=NO_SHOW&occurrence=occ-a",
  ]);
  // The label is the session's start in the viewer's zone (IST here).
  expect(
    screen.getByRole("link", { name: "23 Nov 2026, 10:00 am IST" }),
  ).toBeInTheDocument();
});

it("starts the report in place when only one session has ended, bound to that session", () => {
  const t = threadState({
    reportSessions: [
      {
        id: "occ-a",
        startsAt: "2026-11-16T04:30:00.000Z",
        endsAt: "2026-11-16T05:30:00.000Z",
      },
    ],
  });
  renderConversation(t);
  fireEvent.click(
    screen.getByRole("button", { name: "Report a problem with a session" }),
  );
  // Bound to the session offered, so one ending before the click cannot leave it unnamed.
  expect(t.submitTurn).toHaveBeenCalledWith({
    category: "NO_SHOW",
    chosenLabel: "The expert didn't join",
    binding: { appointmentOccurrenceId: "occ-a" },
  });
});

it("still offers the report while another session's report is the thread shown", () => {
  renderConversation(
    threadState({
      thread: {
        ...payment,
        id: "case-report-b",
        category: "NO_SHOW",
        appointmentOccurrenceId: "occ-b",
      },
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Report a problem with a session" }),
  );
  expect(screen.getByText("Which session was it?")).toBeInTheDocument();
});

it("starts the report entry fresh when the selected session changes", () => {
  const client = new QueryClient();
  const view = (t: ThreadState) => (
    <DisplayZoneProvider zone="Asia/Kolkata">
      <QueryClientProvider client={client}>
        <SessionConversation
          t={t}
          requestsHref="/dashboard/consultee/p1/support"
        />
      </QueryClientProvider>
    </DisplayZoneProvider>
  );
  const { rerender } = render(view(threadState({})));
  fireEvent.click(
    screen.getByRole("button", { name: "Report a problem with a session" }),
  );
  expect(screen.getByText("Which session was it?")).toBeInTheDocument();
  rerender(view(threadState({ occurrenceId: "occ-a" })));
  expect(screen.queryByText("Which session was it?")).not.toBeInTheDocument();
});

it("links each ended session, and only an ended one, to its own report page", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const session = {
    occurrenceId: "occ-a",
    appointmentId: null,
    endsAt: new Date("2026-11-23T11:00:00Z"),
    isTentative: false,
    completionStatus: "COMPLETED",
  };
  expect(
    sessionReportHref(
      "/dashboard/consultee/p1/support/requests",
      "apt-1",
      session,
      now,
    ),
  ).toBe(
    "/dashboard/consultee/p1/support/requests/b_apt-1?intent=NO_SHOW&occurrence=occ-a",
  );
  for (const over of [
    { endsAt: new Date("2026-11-25T11:00:00Z") },
    { isTentative: true },
    { completionStatus: "CANCELLED" },
  ]) {
    expect(
      sessionReportHref("/r", "apt-1", { ...session, ...over }, now),
    ).toBeNull();
  }
});

it("links each open session report on the booking's page, which never shows one", () => {
  renderConversation(
    threadState({
      thread: null,
      started: false,
      isHuman: false,
      sessionReports: [
        {
          caseId: "case-report-a",
          occurrenceId: "occ-a",
          startsAt: "2026-11-14T04:30:00.000Z",
        },
      ],
    }),
  );
  expect(
    screen.getByRole("link", { name: /^Your report about 14 Nov session$/ }),
  ).toHaveAttribute("href", "?occurrence=occ-a");
});
