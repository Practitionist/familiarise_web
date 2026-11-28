/**
 * @jest-environment node
 */

/**
 * Every conversation is a labelled log, and the staff composer only offers
 * uploads where it says who will see them.
 */

jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CaseConversation,
  type ComposerMode,
} from "../../components/dashboard/backoffice/support/CaseConversation";
import { SessionConversation } from "../../components/dashboard/shared/support/SessionConversation";

type CaseData = Parameters<typeof CaseConversation>[0]["data"];
type ThreadState = Parameters<typeof SessionConversation>[0]["t"];

function staff(mode: ComposerMode, status = "OPEN"): string {
  const data = {
    key: "c_case_1",
    kind: "case",
    caseId: "case_1",
    status,
    timeline: [
      {
        id: "m1",
        author: "USER",
        authorName: null,
        body: "Hello",
        internal: false,
        at: "2026-10-20T12:00:00.000Z",
      },
    ],
    handoffSummary: null,
  } as unknown as CaseData;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <CaseConversation
        data={data}
        mode={mode}
        onModeChange={jest.fn()}
        replyDraft=""
        onReplyDraftChange={jest.fn()}
        sending={false}
        onSend={jest.fn()}
        replies={[]}
        suggested={[]}
        helpArticles={[]}
        onInsert={jest.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("staff composer attachments", () => {
  it("labels reply uploads as visible to the customer", () => {
    const html = staff("reply");
    expect(html).toContain("Attach a file");
    expect(html).toContain("Visible to the customer");
    expect(html).toContain('accept="application/pdf,');
  });

  it("offers no upload in Private note mode", () => {
    const html = staff("note");
    expect(html).not.toContain("Attach a file");
    expect(html).toContain("Files can&#x27;t be attached to a private note");
  });

  it("uses pressed toggle buttons, not an orphaned tablist, for the mode", () => {
    const html = staff("note");
    expect(html).not.toContain('role="tablist"');
    expect(html).toMatch(
      /aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Private note/,
    );
  });
});

describe("conversation logs", () => {
  it("marks the staff thread as a labelled log", () => {
    expect(staff("reply")).toMatch(/role="log" aria-label="Conversation"/);
  });

  it("marks the session thread as a labelled log", () => {
    const t = {
      query: { isError: false, isFetching: false, refetch: jest.fn() },
      thread: null,
      messages: [],
      history: {
        timeline: [],
        hasMore: false,
        loading: false,
        loadOlder: jest.fn(),
      },
      availableIntents: [],
      options: [],
      isHuman: false,
      isResolved: false,
      isClosed: false,
      started: false,
      turnPending: false,
      submitTurn: jest.fn(),
      failedTurns: {},
      sessionReports: [],
      retryTurn: jest.fn(),
      lastActions: [],
      waitingLine: "",
      handoffIndex: -1,
    } as unknown as ThreadState;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SessionConversation t={t} requestsHref="/dashboard/x/support" />
      </QueryClientProvider>,
    );
    expect(html).toMatch(/role="log" aria-label="Conversation"/);
  });
});
