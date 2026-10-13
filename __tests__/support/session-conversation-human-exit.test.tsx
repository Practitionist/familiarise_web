/**
 * @jest-environment node
 */

/**
 * The human exit is visible inside a bot flow, not only on the first menu, and
 * a resolved hand-off tells the customer that replying reopens it.
 */

jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionConversation } from "../../components/dashboard/shared/support/SessionConversation";

type ThreadState = Parameters<typeof SessionConversation>[0]["t"];

function thread(over: Partial<ThreadState>): ThreadState {
  const base = {
    query: { isError: false, isFetching: false, refetch: jest.fn() },
    messages: [],
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
    retryTurn: jest.fn(),
    lastActions: [],
    waitingLine: "",
    handoffIndex: -1,
  };
  return { ...base, ...over } as unknown as ThreadState;
}

describe("SessionConversation", () => {
  it("offers Talk to a person beside a mid-flow prompt's options", () => {
    const html = renderToStaticMarkup(<SessionConversation t={thread({})} />);
    expect(html).toContain("I can&#x27;t find the recording");
    expect(html).toContain("Talk to a person");
  });

  it("hides the exit once a person has the case, and says a reply reopens a resolved one", () => {
    const html = renderToStaticMarkup(
      <SessionConversation
        t={thread({ isHuman: true, isResolved: true, options: [] })}
      />,
    );
    expect(html).not.toContain("Talk to a person");
    expect(html).toContain("Replying reopens it");
  });
});
