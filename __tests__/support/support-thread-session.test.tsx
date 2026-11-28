// Invariant: a turn is bound to the case and session it answers when it is
// first sent, and a retry resends that binding; a new intent names only the
// page's session.

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  useSupportThread,
  type ThreadData,
} from "@/components/support/useSupportThread";
import { supportKeys } from "@/lib/support/support-keys";
import { SupportTurnSchema } from "@/schemas/support";

const turnBodies: unknown[] = [];
let failNextTurn = false;

const shown = (id: string, occurrence: string): ThreadData => ({
  thread: {
    id,
    status: "IN_PROGRESS",
    activeChannel: "SELF_SERVE",
    currentNodeId: "start",
    appointmentOccurrenceId: occurrence,
    messages: [],
  },
  intents: [],
  booking: null,
});

function mockFetch(firstRead: ThreadData) {
  let threadReads = 0;
  global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      turnBodies.push(JSON.parse(String(init.body)));
      if (failNextTurn) {
        failNextTurn = false;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            threadId: "case-filed",
            status: "IN_PROGRESS",
            activeChannel: "SELF_SERVE",
            currentNodeId: "start",
            messages: [],
            escalated: false,
            resolved: false,
            accepted: true,
            actions: [],
            appointmentOccurrenceId: "occ-filed",
          },
        }),
      };
    }
    // The first read answers; a refetch after a turn never does.
    if (threadReads++ > 0) return new Promise(() => undefined);
    return {
      ok: true,
      json: async () => ({
        data: firstRead.thread,
        intents: [],
        booking: null,
      }),
    };
  }) as unknown as typeof fetch;
}

function renderThread(
  occurrenceId?: string,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  seedCategory?: string,
) {
  const hook = renderHook(
    () => useSupportThread("appointment", { occurrenceId, seedCategory }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { ...hook, client };
}

const sent = (i: number) => SupportTurnSchema.parse(turnBodies[i]);

beforeEach(() => {
  turnBodies.length = 0;
  failNextTurn = false;
});

it("names the filed case and session on the next answer while the refetch is still out", async () => {
  mockFetch({ thread: null, intents: [], booking: null });
  const { result } = renderThread();
  await waitFor(() => expect(result.current.data).toBeDefined());

  act(() => {
    result.current.submitTurn({ category: "NO_SHOW" });
  });
  await waitFor(() => expect(result.current.turnPending).toBe(false));
  act(() => {
    result.current.submitTurn({ chosenOptionId: "expert" });
  });
  await waitFor(() => expect(turnBodies).toHaveLength(2));
  expect(sent(1)).toMatchObject({
    chosenOptionId: "expert",
    caseId: "case-filed",
    appointmentOccurrenceId: "occ-filed",
  });
});

it("sends no session with a new intent when the page names none, whatever the shown thread is about", async () => {
  mockFetch(shown("case-a", "occ-a"));
  const { result } = renderThread();
  await waitFor(() => expect(result.current.thread?.id).toBe("case-a"));
  act(() => {
    result.current.submitTurn({ category: "NO_SHOW" });
  });
  await waitFor(() => expect(turnBodies).toHaveLength(1));
  expect(sent(0)).toEqual(
    expect.not.objectContaining({ appointmentOccurrenceId: expect.anything() }),
  );
});

it("retries a failed answer on the case and session it was first sent for after the thread moved", async () => {
  mockFetch(shown("case-a", "occ-a"));
  const { result, client } = renderThread();
  await waitFor(() => expect(result.current.thread?.id).toBe("case-a"));

  failNextTurn = true;
  act(() => {
    result.current.submitTurn({
      chosenOptionId: "expert",
      chosenLabel: "The expert",
    });
  });
  await waitFor(() =>
    expect(Object.keys(result.current.failedTurns)).toHaveLength(1),
  );
  // The page now shows session B's case.
  act(() => {
    client.setQueryData(
      supportKeys.thread("appointment"),
      shown("case-b", "occ-b"),
    );
  });
  act(() => {
    result.current.retryTurn(Object.keys(result.current.failedTurns)[0]);
  });
  await waitFor(() => expect(turnBodies).toHaveLength(2));
  expect(sent(1)).toMatchObject({
    chosenOptionId: "expert",
    caseId: "case-a",
    appointmentOccurrenceId: "occ-a",
  });

  // The retry's answer is not written into B's thread, so a fresh answer still binds to B.
  await waitFor(() => expect(result.current.turnPending).toBe(false));
  act(() => {
    result.current.submitTurn({ chosenOptionId: "expert" });
  });
  await waitFor(() => expect(turnBodies).toHaveLength(3));
  expect(sent(2)).toMatchObject({
    caseId: "case-b",
    appointmentOccurrenceId: "occ-b",
  });
});

it("moves the page to the booking thread a fresh intent landed on, keeps it there through the refetch, and sends a reply typed afterwards to that case", async () => {
  const reads: string[] = [];
  let threadReads = 0;
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      turnBodies.push(JSON.parse(String(init.body)));
      return {
        ok: true,
        json: async () => ({
          data: {
            threadId: "case-pay",
            status: "IN_PROGRESS",
            activeChannel: "SELF_SERVE",
            currentNodeId: "start",
            messages: [
              { sender: "BOT", body: "What happened with the payment?" },
            ],
            escalated: false,
            resolved: false,
            accepted: true,
            actions: [],
            appointmentOccurrenceId: null,
          },
        }),
      };
    }
    reads.push(url);
    // A read naming the payment case on this session's page answers that case, as the reader does.
    if (
      threadReads++ > 0 &&
      new URL(url, "https://x.test").searchParams.get("caseId") === "case-pay"
    ) {
      return {
        ok: true,
        json: async () => ({
          data: {
            ...shown("case-pay", "occ-a").thread!,
            appointmentOccurrenceId: null,
            messages: [
              {
                id: "m-pay-1",
                seq: 1,
                sender: "USER",
                body: "Payment problem",
                createdAt: "2026-11-23T12:01:00.000Z",
              },
              {
                id: "m-pay-2",
                seq: 2,
                sender: "BOT",
                body: "What happened with the payment?",
                createdAt: "2026-11-23T12:01:01.000Z",
              },
            ],
          },
          intents: [],
          booking: null,
        }),
      };
    }
    // The page opened on the session's no-show report, which has its own messages.
    const report = shown("case-report", "occ-a").thread!;
    return {
      ok: true,
      json: async () => ({
        data: {
          ...report,
          messages: [
            {
              id: "m-report",
              seq: 1,
              sender: "BOT",
              body: "Who couldn't make it?",
              createdAt: "2026-11-23T12:00:00.000Z",
            },
          ],
        },
        intents: [],
        booking: null,
      }),
    };
  }) as unknown as typeof fetch;
  const { result } = renderThread("occ-a");
  await waitFor(() => expect(result.current.thread?.id).toBe("case-report"));

  act(() => {
    result.current.submitTurn({
      category: "PAYMENT_STATUS",
      chosenLabel: "Payment problem",
    });
  });
  await waitFor(() => expect(result.current.thread?.id).toBe("case-pay"));
  expect(result.current.thread?.appointmentOccurrenceId).toBeNull();
  expect(result.current.messages.map((m) => m.body)).toEqual([
    "Payment problem",
    "What happened with the payment?",
  ]);
  await waitFor(() => expect(reads).toHaveLength(2));
  const refetch = new URL(reads[1], "https://x.test").searchParams;
  expect(refetch.get("caseId")).toBe("case-pay");
  // The session stays named, so the page's intents and report links are still that session's.
  expect(refetch.get("occurrence")).toBe("occ-a");
  // The refetch has answered: its messages carry the server's ids.
  await waitFor(() =>
    expect(result.current.messages.map((m) => m.id)).toEqual([
      "m-pay-1",
      "m-pay-2",
    ]),
  );
  expect(result.current.thread).toMatchObject({
    id: "case-pay",
    appointmentOccurrenceId: null,
  });

  act(() => {
    result.current.submitTurn({ userMessage: "I was charged twice" });
  });
  await waitFor(() => expect(turnBodies).toHaveLength(2));
  expect(sent(1)).toMatchObject({
    userMessage: "I was charged twice",
    caseId: "case-pay",
  });
  expect(sent(1)).not.toHaveProperty("appointmentOccurrenceId");
});

/** A complete turn result: the case and session it landed on, with the bot's reply. */
const turnResult = (threadId: string, occurrenceId: string) => ({
  threadId,
  status: "IN_PROGRESS",
  activeChannel: "SELF_SERVE",
  currentNodeId: "start",
  messages: [{ sender: "BOT", body: `Noted on ${threadId}`, metadata: null }],
  escalated: false,
  resolved: false,
  accepted: true,
  actions: [],
  appointmentOccurrenceId: occurrenceId,
});

/** A thread read that answers by the session the URL names; a turn answers `onTurn`, and the refetch after it never returns. */
function mockSessionReads(
  bySession: Record<string, ThreadData["thread"]>,
  onTurn: ReturnType<typeof turnResult>,
) {
  const reads: string[] = [];
  let turned = false;
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      turnBodies.push(JSON.parse(String(init.body)));
      turned = true;
      return { ok: true, json: async () => ({ data: onTurn }) };
    }
    if (turned) return new Promise(() => undefined);
    reads.push(url);
    const session = new URL(url, "https://x.test").searchParams.get(
      "occurrence",
    );
    return {
      ok: true,
      json: async () => ({
        data: bySession[session ?? ""] ?? null,
        intents: [{ category: "NO_SHOW", title: "The expert didn't join" }],
        booking: null,
      }),
    };
  }) as unknown as typeof fetch;
  return reads;
}

it("answers on session B's case from B's page, after A's page filled the same cache", async () => {
  const reads = mockSessionReads(
    {
      "occ-a": shown("case-a", "occ-a").thread,
      "occ-b": shown("case-b", "occ-b").thread,
    },
    turnResult("case-b", "occ-b"),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const pageA = renderThread("occ-a", client);
  await waitFor(() => expect(pageA.result.current.thread?.id).toBe("case-a"));
  pageA.unmount();

  const pageB = renderThread("occ-b", client);
  await waitFor(() => expect(pageB.result.current.thread?.id).toBe("case-b"));
  // B's read never names A's case.
  expect(
    reads.some((u) => u.includes("occurrence=occ-b") && u.includes("case-a")),
  ).toBe(false);
  act(() => {
    pageB.result.current.submitTurn({ chosenOptionId: "attended" });
  });
  await waitFor(() => expect(turnBodies).toHaveLength(1));
  expect(sent(0)).toMatchObject({
    chosenOptionId: "attended",
    caseId: "case-b",
    appointmentOccurrenceId: "occ-b",
  });
  // The answer is processed onto B's thread.
  await waitFor(() =>
    expect(pageB.result.current.messages.map((m) => m.body)).toContain(
      "Noted on case-b",
    ),
  );
  expect(pageB.result.current.thread).toMatchObject({
    id: "case-b",
    appointmentOccurrenceId: "occ-b",
  });
});

it("starts a session's report on its page beside an open human payment case", async () => {
  // The booking's only case is a payment conversation a person handles.
  mockSessionReads(
    {
      "": {
        ...shown("case-pay", "").thread!,
        activeChannel: "HUMAN",
        appointmentOccurrenceId: null,
      },
    },
    turnResult("case-report-a", "occ-a"),
  );
  const { result } = renderThread("occ-a", undefined, "NO_SHOW");
  await waitFor(() => expect(turnBodies).toHaveLength(1));
  expect(result.current.thread?.id).not.toBe("case-pay");
  expect(sent(0)).toEqual(
    expect.objectContaining({
      category: "NO_SHOW",
      appointmentOccurrenceId: "occ-a",
    }),
  );
  // The report's answer is processed onto its own session case.
  await waitFor(() =>
    expect(result.current.messages.map((m) => m.body)).toContain(
      "Noted on case-report-a",
    ),
  );
  expect(result.current.thread).toMatchObject({
    id: "case-report-a",
    appointmentOccurrenceId: "occ-a",
  });
});

it("a turn still pending when the page moves to another session completes into the thread it was sent from, and leaves the other session's thread and actions alone", async () => {
  // Session A has no report yet; session B shows its own case.
  let answerTurn: (response: unknown) => void = () => undefined;
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      turnBodies.push(JSON.parse(String(init.body)));
      return new Promise((resolve) => (answerTurn = resolve));
    }
    const forB = String(url).includes("occ-b");
    return {
      ok: true,
      json: async () => ({
        data: forB ? shown("case-b", "occ-b").thread : null,
        intents: [],
        booking: null,
      }),
    };
  }) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page = renderHook(
    ({ occurrenceId }: { occurrenceId: string }) =>
      useSupportThread("appointment", { occurrenceId }),
    {
      initialProps: { occurrenceId: "occ-a" },
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await waitFor(() => expect(page.result.current.data).toBeDefined());

  act(() => {
    page.result.current.submitTurn({ category: "NO_SHOW" });
  });
  await waitFor(() => expect(turnBodies).toHaveLength(1));
  // The person opens session B's page while A's turn is still out.
  page.rerender({ occurrenceId: "occ-b" });
  await waitFor(() => expect(page.result.current.thread?.id).toBe("case-b"));

  await act(async () => {
    answerTurn({
      ok: true,
      json: async () => ({
        data: {
          ...turnResult("case-a-new", "occ-a"),
          actions: [{ kind: "LINK", label: "Open the booking", href: "/x" }],
        },
      }),
    });
  });
  await waitFor(() => expect(page.result.current.turnPending).toBe(false));

  // B's page still shows B's case, with nothing of A's answer on it.
  expect(page.result.current.thread).toMatchObject({
    id: "case-b",
    appointmentOccurrenceId: "occ-b",
  });
  expect(page.result.current.messages.map((m) => m.body)).not.toContain(
    "Noted on case-a-new",
  );
  expect(page.result.current.lastActions).toEqual([]);
  // A's answer is on A's thread.
  const threadA = client.getQueryData<ThreadData>(
    supportKeys.thread("appointment", "occ-a"),
  )?.thread;
  expect(threadA?.messages.map((m) => m.body)).toContain("Noted on case-a-new");
});

it("keeps a session's action cards and unsent messages with that session's thread: another session's page shows none of them, and they are there again on return", async () => {
  let turns = 0;
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      // The first turn is answered with an action card; the second never reaches the server.
      if (turns++ > 0)
        return { ok: false, status: 503, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          data: {
            ...turnResult("case-a", "occ-a"),
            actions: [{ kind: "LINK", label: "Open the booking", href: "/x" }],
          },
        }),
      };
    }
    const occurrence = String(url).includes("occ-b") ? "occ-b" : "occ-a";
    return {
      ok: true,
      json: async () => ({
        data: shown(occurrence === "occ-b" ? "case-b" : "case-a", occurrence)
          .thread,
        intents: [],
        booking: null,
      }),
    };
  }) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page = renderHook(
    ({ occurrenceId }: { occurrenceId: string }) =>
      useSupportThread("appointment", { occurrenceId }),
    {
      initialProps: { occurrenceId: "occ-a" },
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await waitFor(() => expect(page.result.current.thread?.id).toBe("case-a"));
  act(() => {
    page.result.current.submitTurn({ userMessage: "The call dropped" });
  });
  await waitFor(() => expect(page.result.current.lastActions).toHaveLength(1));
  act(() => {
    page.result.current.submitTurn({ userMessage: "Are you there?" });
  });
  await waitFor(() =>
    expect(Object.values(page.result.current.failedTurns)).toHaveLength(1),
  );

  page.rerender({ occurrenceId: "occ-b" });
  await waitFor(() => expect(page.result.current.thread?.id).toBe("case-b"));
  expect(page.result.current.lastActions).toEqual([]);
  expect(page.result.current.failedTurns).toEqual({});

  page.rerender({ occurrenceId: "occ-a" });
  expect(page.result.current.lastActions).toHaveLength(1);
  expect(
    Object.values(page.result.current.failedTurns).map((f) => f.body),
  ).toEqual(["Are you there?"]);
});

/** A thread read answered at once for the booking's page; `onSessionRead` answers a session's, and `onTurn` each turn. */
function mockReadsAndTurns(opts: {
  booking: ThreadData;
  onSessionRead?: () => unknown;
  onTurn: () => unknown;
}) {
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      turnBodies.push(JSON.parse(String(init.body)));
      return opts.onTurn();
    }
    if (String(url).includes("occurrence=") && opts.onSessionRead) {
      return opts.onSessionRead();
    }
    return {
      ok: true,
      json: async () => ({
        data: opts.booking.thread,
        intents: [],
        booking: null,
      }),
    };
  }) as unknown as typeof fetch;
}

const unavailable = { ok: false, status: 503, json: async () => ({}) };

it("a turn on the booking's page leaves a session page's first read alone", async () => {
  let answerSession: (response: unknown) => void = () => undefined;
  mockReadsAndTurns({
    booking: shown("case-book", "occ-x"),
    onSessionRead: () => new Promise((resolve) => (answerSession = resolve)),
    onTurn: () => unavailable,
  });
  const booking = renderThread();
  await waitFor(() =>
    expect(booking.result.current.thread?.id).toBe("case-book"),
  );
  // The same client also holds a session's page, still loading.
  const session = renderThread("occ-a", booking.client);

  act(() => {
    booking.result.current.submitTurn({
      chosenOptionId: "expert",
      chosenLabel: "The expert",
    });
  });
  await waitFor(() =>
    expect(Object.keys(booking.result.current.failedTurns)).toHaveLength(1),
  );
  await act(async () => {
    answerSession({
      ok: true,
      json: async () => ({
        data: shown("case-a", "occ-a").thread,
        intents: [],
        booking: null,
      }),
    });
  });

  await waitFor(() => expect(session.result.current.thread?.id).toBe("case-a"));
});

it("a turn that fails takes back only its own message: one that arrived while it was out stays", async () => {
  let answerTurn: (response: unknown) => void = () => undefined;
  mockReadsAndTurns({
    booking: shown("case-a", "occ-a"),
    onTurn: () => new Promise((resolve) => (answerTurn = resolve)),
  });
  const { result, client } = renderThread();
  await waitFor(() => expect(result.current.thread?.id).toBe("case-a"));

  act(() => {
    result.current.submitTurn({ userMessage: "Hello?" });
  });
  await waitFor(() => expect(turnBodies).toHaveLength(1));
  // Another reader of this thread fetched the team's reply while the turn was out.
  act(() => {
    client.setQueryData<ThreadData>(supportKeys.thread("appointment"), (old) =>
      old?.thread
        ? {
            ...old,
            thread: {
              ...old.thread,
              messages: [
                ...old.thread.messages,
                {
                  id: "m-agent",
                  seq: 1,
                  sender: "AGENT",
                  body: "We're on it",
                  createdAt: "2026-11-23T12:00:00.000Z",
                },
              ],
            },
          }
        : old,
    );
  });
  await act(async () => {
    answerTurn(unavailable);
  });
  await waitFor(() =>
    expect(Object.keys(result.current.failedTurns)).toHaveLength(1),
  );

  expect(result.current.messages.map((m) => m.body)).toEqual(["We're on it"]);
});

it("a retry for a case the page no longer shows puts no pending message on the case it shows now, and stays retryable if it fails again", async () => {
  mockReadsAndTurns({
    booking: shown("case-a", "occ-a"),
    onTurn: () => unavailable,
  });
  const { result, client } = renderThread();
  await waitFor(() => expect(result.current.thread?.id).toBe("case-a"));
  act(() => {
    result.current.submitTurn({
      chosenOptionId: "expert",
      chosenLabel: "The expert",
    });
  });
  await waitFor(() =>
    expect(Object.keys(result.current.failedTurns)).toHaveLength(1),
  );
  // The page now shows another case.
  act(() => {
    client.setQueryData(
      supportKeys.thread("appointment"),
      shown("case-b", "occ-b"),
    );
  });
  let answerRetry: (response: unknown) => void = () => undefined;
  mockReadsAndTurns({
    booking: shown("case-b", "occ-b"),
    onTurn: () => new Promise((resolve) => (answerRetry = resolve)),
  });

  act(() => {
    result.current.retryTurn(Object.keys(result.current.failedTurns)[0]);
  });
  await waitFor(() => expect(turnBodies).toHaveLength(2));
  expect(result.current.messages.map((m) => m.body)).not.toContain(
    "The expert",
  );

  await act(async () => {
    answerRetry(unavailable);
  });
  await waitFor(() =>
    expect(
      Object.values(result.current.failedTurns).map((f) => f.body),
    ).toEqual(["The expert"]),
  );
});
