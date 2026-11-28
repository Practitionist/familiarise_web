/**
 * @jest-environment node
 */

/**
 * The human exit is visible inside a bot flow, not only on the first menu, and
 * a resolved hand-off tells the customer that a reply will not reopen it.
 */

jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionConversation } from "../../components/dashboard/shared/support/SessionConversation";

type ThreadState = Parameters<typeof SessionConversation>[0]["t"];

function render(t: ThreadState): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SessionConversation
        t={t}
        requestsHref="/dashboard/consultee/p1/support"
      />
    </QueryClientProvider>,
  );
}

function thread(over: Partial<ThreadState>): ThreadState {
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
      { category: "RECORDING_ACCESS", label: "Recording access" },
      { category: "OTHER", label: "Talk to a person", escalates: true },
    ],
    options: [{ id: "missing", label: "I can't find the recording" }],
    isHuman: false,
    isResolved: false,
    isClosed: false,
    started: true,
    turnPending: false,
    submitTurn: jest.fn(),
    failedTurns: {},
    sessionReports: [],
    retryTurn: jest.fn(),
    lastActions: [],
    waitingLine: "",
    handoffIndex: -1,
  };
  return { ...base, ...over } as unknown as ThreadState;
}

describe("SessionConversation", () => {
  it("offers Talk to a person beside a mid-flow prompt's options", () => {
    const html = render(thread({}));
    expect(html).toContain("I can&#x27;t find the recording");
    expect(html).toContain("Talk to a person");
  });

  it("hides the exit once a person has the case, and says a reply won't reopen a resolved one", () => {
    const html = render(
      thread({
        isHuman: true,
        isResolved: true,
        options: [],
        thread: {
          id: "case-1",
          status: "RESOLVED",
          activeChannel: "HUMAN",
          currentNodeId: null,
          resolvedAt: new Date().toISOString(),
          messages: [],
        },
      }),
    );
    expect(html).not.toContain("Talk to a person");
    expect(html).toContain("Your reply won&#x27;t reopen it");
    expect(html).not.toContain("Replying reopens it");
  });
});
