/**
 * @jest-environment jsdom
 */

/**
 * The human exit is visible inside a bot flow, not only on the first menu, and
 * a resolved hand-off tells the customer that replying reopens it.
 *
 * The conversation now rides on ONE canonical `SupportCase`: the pane reads
 * the case id and the case's own status off the thread the hook hands it, so
 * the exit, the CSAT offer and the "replying reopens it" note all follow the
 * case rather than a legacy ticket row.
 */

jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SessionConversation } from "../../components/dashboard/shared/support/SessionConversation";
import type {
  SupportThread,
  ThreadMessage,
} from "../../components/support/useSupportThread";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout engine, so the pane's scroll-to-the-end would throw.
window.HTMLElement.prototype.scrollIntoView = jest.fn();

type ThreadState = Parameters<typeof SessionConversation>[0]["t"];
type History = ThreadState["history"];

const CASE_ID = "case_1";

/** The canonical case behind the conversation, as the GET route returns it. */
function caseThread(over: Partial<SupportThread> = {}): SupportThread {
  return {
    id: CASE_ID,
    status: "IN_PROGRESS",
    activeChannel: "SELF_SERVE",
    currentNodeId: "node_recording",
    resolvedAt: null,
    csatRating: null,
    hasMore: false,
    nextBeforeSeq: null,
    messages: [],
    supportTicket: null,
    ...over,
  };
}

function history(): History {
  return {
    timeline: [],
    hasMore: false,
    loading: false,
    loadOlder: jest.fn(async () => undefined),
  };
}

function thread(over: Partial<ThreadState> = {}): ThreadState {
  const base = {
    query: { isError: false, isFetching: false, refetch: jest.fn() },
    data: undefined,
    thread: caseThread(),
    messages: [] as ThreadMessage[],
    history: history(),
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
    submitTurn: jest.fn(() => true),
    failedTurns: {},
    retryTurn: jest.fn(),
    lastActions: [],
    lastOutcomeId: null,
    waitingLine: "",
    handoffIndex: -1,
  };
  return { ...base, ...over } as unknown as ThreadState;
}

/** What `/api/support/cases/<id>/actions` answers with for a customer view. */
const RESOLUTION = {
  decisions: [],
  recommendations: [],
  holds: [],
  evidenceRequests: [],
  recipients: [],
  canManage: false,
  canExecuteMoney: false,
  ownershipScope: "PERSONAL",
  updatedAt: "2026-10-01T10:00:00.000Z",
};

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/actions")) return okJson({ data: RESOLUTION });
    if (url.includes("/attachments")) return okJson({ data: [] });
    return okJson({ data: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (global as { fetch?: unknown }).fetch;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderConversation(t: ThreadState): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SessionConversation t={t} />
      </QueryClientProvider>,
    );
  });
  await flush();
}

describe("SessionConversation", () => {
  it("offers Talk to a person beside a mid-flow prompt's options", async () => {
    await renderConversation(thread());
    expect(container.textContent).toContain("I can't find the recording");
    expect(container.textContent).toContain("Talk to a person");
    // One canonical case backs the whole conversation.
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/support/cases/${CASE_ID}/attachments`,
    );
  });

  it("hides the exit once a person has the case, and says a reply reopens a resolved one", async () => {
    await renderConversation(
      thread({
        isHuman: true,
        isResolved: true,
        options: [],
        thread: caseThread({
          status: "RESOLVED",
          activeChannel: "HUMAN",
          resolvedAt: new Date(Date.now() - 3_600_000).toISOString(),
          supportTicket: {
            referenceNumber: "FAM-2026-000001",
            ackDueAt: null,
          },
        }),
      }),
    );
    expect(container.textContent).not.toContain("Talk to a person");
    expect(container.textContent).toContain("Replying reopens it");
    // The case's own status drives the CSAT offer, not a legacy ticket row.
    expect(container.textContent).toContain(
      "How did our support team do on this request?",
    );
  });
});
