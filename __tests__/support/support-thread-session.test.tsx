// Invariant: an answer pressed straight after the intent turn names the session
// that turn filed on, before the thread's refetch has returned.

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useSupportThread } from "@/components/support/useSupportThread";
import { SupportTurnSchema } from "@/schemas/support";

const turnBodies: unknown[] = [];

beforeEach(() => {
  turnBodies.length = 0;
  let threadReads = 0;
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      turnBodies.push(JSON.parse(String(init.body)));
      return {
        ok: true,
        json: async () => ({
          data: {
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
    // The first read answers; the refetch after the turn never does.
    if (threadReads++ > 0) return new Promise(() => undefined);
    return {
      ok: true,
      json: async () => ({ data: null, intents: [], booking: null }),
    };
  }) as unknown as typeof fetch;
});

it("names the filed session on the next answer while the refetch is still out", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(() => useSupportThread("appointment"), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await waitFor(() => expect(result.current.data).toBeDefined());

  act(() => {
    result.current.submitTurn({ category: "NO_SHOW" });
  });
  await waitFor(() => expect(result.current.turnPending).toBe(false));
  act(() => {
    result.current.submitTurn({ chosenOptionId: "expert" });
  });
  await waitFor(() => expect(turnBodies).toHaveLength(2));

  expect(SupportTurnSchema.parse(turnBodies[1])).toMatchObject({
    chosenOptionId: "expert",
    appointmentOccurrenceId: "occ-filed",
  });
});
