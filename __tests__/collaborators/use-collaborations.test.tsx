/**
 * @jest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import {
  CollaborationRefusal,
  collaborationKeys,
  describeRefusal,
  useEndCollaboration,
  useInviteCollaborator,
  useMyCollaborations,
  usePlanTeam,
  useRespondToInvitation,
  useUpdatePendingTerms,
  type PlanRef,
} from "@/hooks/use-collaborations";
import {
  inviteCollaboratorSchemas,
  respondToInvitationSchema,
  updatePendingTermsSchemas,
} from "@/schemas/collaborators";

const PLAN: PlanRef = { planType: "webinar", planId: "plan-1" };
const PLAN_URL = "/api/collaborations/webinar/plan-1";
const MINE_URL = "/api/collaborations";

/** A plan's team as the route answers a manager. */
const TEAM_BODY = {
  data: [
    {
      id: "collab-1",
      role: "CO_HOST",
      tier: "PRESENTER",
      status: "PENDING",
      revenueShareBps: 2500,
      createdAt: "2026-11-01T10:00:00.000Z",
      acceptedAt: null,
      expiresAt: "2026-11-15T10:00:00.000Z",
      consultantProfile: {
        id: "profile-2",
        userId: "user-2",
        user: { name: "Priya", image: null },
      },
    },
  ],
  viewer: "manager",
  canManage: true,
};

const MINE_BODY = {
  data: {
    webinarCollaborations: [],
    classCollaborations: [],
    hostedWebinarPlans: [],
    hostedClassPlans: [],
  },
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
/** What the next write answers; reads always answer their list. */
let writeAnswer: { status: number; body: unknown } = { status: 200, body: {} };
let client: QueryClient;

/** As much of a fetch answer as the hooks read. */
const answer = (status: number, body: unknown) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

const reads = (url: string) =>
  calls.filter((c) => c.method === "GET" && c.url === url).length;
const lastWrite = () => {
  const writes = calls.filter((c) => c.method !== "GET");
  const call = writes[writes.length - 1];
  if (!call) throw new Error("no write was sent");
  return call;
};

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  calls = [];
  writeAnswer = { status: 200, body: { data: { id: "collab-1" } } };
  globalThis.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (method !== "GET") {
        return answer(writeAnswer.status, writeAnswer.body);
      }
      return answer(200, url === PLAN_URL ? TEAM_BODY : MINE_BODY);
    },
  ) as unknown as typeof fetch;
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Both lists on screen beside every write, the way the pages mount them. */
function useScreen() {
  return {
    mine: useMyCollaborations(),
    team: usePlanTeam(PLAN),
    invite: useInviteCollaborator(PLAN),
    update: useUpdatePendingTerms(PLAN),
    end: useEndCollaboration(PLAN),
    respond: useRespondToInvitation(),
  };
}

async function mountScreen() {
  const view = renderHook(useScreen, { wrapper });
  await waitFor(() => {
    expect(view.result.current.mine.isSuccess).toBe(true);
    expect(view.result.current.team.isSuccess).toBe(true);
  });
  return view;
}

it("keeps every list under one root, so one invalidation reaches them all", () => {
  const [root] = collaborationKeys.all;
  expect(collaborationKeys.mine()[0]).toBe(root);
  expect(collaborationKeys.mine("org-1", true)[0]).toBe(root);
  expect(collaborationKeys.plan(PLAN)[0]).toBe(root);
  expect(collaborationKeys.mine()).not.toEqual(
    collaborationKeys.mine("org-1", true),
  );
});

it("reads a plan's team with what the viewer may do to it", async () => {
  const { result } = await mountScreen();
  expect(result.current.team.data).toMatchObject({
    viewer: "manager",
    canManage: true,
    members: [{ id: "collab-1", role: "CO_HOST", revenueShareBps: 2500 }],
  });
});

it("an invite sends the body the route accepts and reloads every list", async () => {
  const { result } = await mountScreen();
  await act(() =>
    result.current.invite.mutateAsync({
      consultantProfileId: "profile-3",
      role: "MODERATOR",
      sharePercent: 15,
    }),
  );
  const sent = lastWrite();
  expect([sent.method, sent.url]).toEqual(["POST", PLAN_URL]);
  expect(inviteCollaboratorSchemas.webinar.parse(sent.body)).toEqual({
    consultantProfileId: "profile-3",
    role: "MODERATOR",
    sharePercent: 15,
  });
  await waitFor(() => expect(reads(MINE_URL)).toBe(2));
  await waitFor(() => expect(reads(PLAN_URL)).toBe(2));
});

it("a change of pending terms sends the body the route accepts and reloads every list", async () => {
  const { result } = await mountScreen();
  await act(() =>
    result.current.update.mutateAsync({
      collaboratorId: "collab-1",
      role: "GUEST_SPEAKER",
      sharePercent: 20,
    }),
  );
  const sent = lastWrite();
  expect([sent.method, sent.url]).toEqual(["PATCH", `${PLAN_URL}/collab-1`]);
  expect(updatePendingTermsSchemas.webinar.parse(sent.body)).toEqual({
    role: "GUEST_SPEAKER",
    sharePercent: 20,
  });
  await waitFor(() => expect(reads(MINE_URL)).toBe(2));
  await waitFor(() => expect(reads(PLAN_URL)).toBe(2));
});

it("removing or leaving deletes the row and reloads every list", async () => {
  const { result } = await mountScreen();
  await act(() => result.current.end.mutateAsync("collab-1"));
  const sent = lastWrite();
  expect([sent.method, sent.url, sent.body]).toEqual([
    "DELETE",
    `${PLAN_URL}/collab-1`,
    null,
  ]);
  await waitFor(() => expect(reads(MINE_URL)).toBe(2));
  await waitFor(() => expect(reads(PLAN_URL)).toBe(2));
});

it("an accept carries the terms on screen, a decline carries none, and both reload every list", async () => {
  const { result } = await mountScreen();
  await act(() =>
    result.current.respond.mutateAsync({
      collaboratorId: "collab-1",
      response: "ACCEPTED",
      seenTerms: { role: "CO_HOST", sharePercent: 25 },
    }),
  );
  const accept = lastWrite();
  expect([accept.method, accept.url]).toEqual([
    "PATCH",
    "/api/collaborations/collab-1/respond",
  ]);
  expect(respondToInvitationSchema.parse(accept.body)).toEqual({
    response: "ACCEPTED",
    seenTerms: { role: "CO_HOST", sharePercent: 25 },
  });
  await waitFor(() => expect(reads(MINE_URL)).toBe(2));

  await act(() =>
    result.current.respond.mutateAsync({
      collaboratorId: "collab-1",
      response: "DECLINED",
    }),
  );
  expect(lastWrite().body).toEqual({ response: "DECLINED" });
  await waitFor(() => expect(reads(MINE_URL)).toBe(3));
  await waitFor(() => expect(reads(PLAN_URL)).toBe(3));
});

it("a refused accept surfaces the terms the host changed to, and still reloads the lists", async () => {
  const { result } = await mountScreen();
  writeAnswer = {
    status: 409,
    body: {
      error:
        "The host changed this invitation's terms. Review the new terms before accepting.",
      code: "TERMS_CHANGED",
      terms: { role: "MODERATOR", sharePercent: 5 },
    },
  };
  let refusal: unknown;
  await act(async () => {
    refusal = await result.current.respond
      .mutateAsync({
        collaboratorId: "collab-1",
        response: "ACCEPTED",
        seenTerms: { role: "CO_HOST", sharePercent: 25 },
      })
      .catch((error: unknown) => error);
  });
  expect(refusal).toBeInstanceOf(CollaborationRefusal);
  expect(refusal).toMatchObject({
    code: "TERMS_CHANGED",
    status: 409,
    detail: { terms: { role: "MODERATOR", sharePercent: 5 } },
  });
  await waitFor(() => expect(reads(MINE_URL)).toBe(2));
});

it("a team that fails to load is an error with the server's sentence, never an empty team", async () => {
  globalThis.fetch = jest.fn(async () =>
    answer(403, {
      error: "You are not on this plan's team.",
      code: "FORBIDDEN",
    }),
  ) as unknown as typeof fetch;
  const { result } = renderHook(() => usePlanTeam(PLAN), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
  expect(result.current.error).toMatchObject({
    code: "FORBIDDEN",
    message: "You are not on this plan's team.",
  });
});

it("a refusal whose detail has an unexpected shape keeps the server's sentence and drops the detail", async () => {
  globalThis.fetch = jest.fn(async () =>
    answer(409, {
      error: "This expert recently declined or left this plan.",
      code: "COOLDOWN",
      retryAt: "next week",
    }),
  ) as unknown as typeof fetch;
  const { result } = renderHook(() => usePlanTeam(PLAN), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.error).toMatchObject({
    code: "COOLDOWN",
    message: "This expert recently declined or left this plan.",
  });
  expect(result.current.error?.detail.retryAt).toBeUndefined();
});

it("an answer of the wrong shape is a failed load too", async () => {
  globalThis.fetch = jest.fn(async () =>
    answer(200, { data: [{ id: "x" }] }),
  ) as unknown as typeof fetch;
  const { result } = renderHook(() => usePlanTeam(PLAN), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.error?.code).toBe("UNKNOWN");
});

describe("describeRefusal", () => {
  const refusal = (code: string, detail = {}) =>
    new CollaborationRefusal(code, "The server's sentence.", 409, detail);

  it("says a refusal and its recovery once: its own sentence when it holds the date or the wait, the server's otherwise", () => {
    expect(
      describeRefusal(
        refusal("COOLDOWN", { retryAt: "2026-11-23T10:00:00.000Z" }),
      ).sentence,
    ).toBe(
      "This expert recently declined or left this plan, and can be invited again from 23 November 2026.",
    );
    expect(
      describeRefusal(refusal("RATE_LIMITED", { retryAfterSeconds: 125 }))
        .sentence,
    ).toBe("You have made too many requests; try again in about 3 minutes.");
    expect(
      describeRefusal(refusal("RATE_LIMITED", { retryAfterSeconds: 20 }))
        .sentence,
    ).toBe("You have made too many requests; try again in about 1 minute.");
    for (const code of ["COOLDOWN", "RATE_LIMITED", "HOLDS_A_SEAT"]) {
      expect(describeRefusal(refusal(code)).sentence).toBe(
        "The server's sentence.",
      );
    }
  });

  it("adds what is left to give to the server's sentence about shares", () => {
    expect(
      describeRefusal(refusal("SHARES_EXCEEDED", { availablePercent: 15 }))
        .sentence,
    ).toBe("The server's sentence. 15% is still free on this plan.");
  });

  it("offers a reload only when the screen is out of date", () => {
    expect(describeRefusal(refusal("SCHEDULE_CHANGED")).reload).toBe(true);
    expect(describeRefusal(refusal("CONFLICT")).reload).toBe(true);
    expect(describeRefusal(refusal("CALENDAR_CLASH")).reload).toBe(false);
  });
});
