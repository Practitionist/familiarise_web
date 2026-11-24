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

function renderThread(occurrenceId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const hook = renderHook(
    () => useSupportThread("appointment", { occurrenceId }),
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

it("moves the page to the booking thread a fresh intent landed on, and keeps it there on the refetch", async () => {
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
    if (threadReads++ > 0) return new Promise(() => undefined);
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
  expect(new URL(reads[1], "https://x.test").searchParams.get("caseId")).toBe(
    "case-pay",
  );
});
