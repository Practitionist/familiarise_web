import * as React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockToast = jest.fn();
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { CaseChatPanel } from "../../components/dashboard/backoffice/support/CaseChatPanel";
import { registerReauthHandler } from "../../lib/auth/reauth-client";

const FUTURE = "2030-01-01T10:00:00.000Z";
const START = "2026-10-20T09:00:00.000Z";

function grant(overrides: Record<string, unknown>) {
  return {
    id: "grant_1",
    kind: "READ",
    basis: "OPEN_CASE",
    grantedById: "staff_1",
    grantedByName: "Asha",
    mine: true,
    live: true,
    windowStart: START,
    expiresAt: FUTURE,
    endedAt: null,
    endReason: null,
    streamJoinedAt: null,
    streamLeftAt: null,
    withholdNotice: false,
    createdAt: START,
    ...overrides,
  };
}

const parties = [
  { userId: "u_rep", name: "Riya Reporter", role: "REPORTER" },
  { userId: "u_a", name: "Arun Attendee", role: "ATTENDEE" },
  { userId: "u_b", name: "Bela Attendee", role: "ATTENDEE" },
];

function chatStatus(overrides: Record<string, unknown> = {}) {
  return {
    channel: { type: "messaging", kind: "DM" },
    read: { ok: true },
    intervene: { ok: false, code: "BASIS_NOT_MET", message: "No basis yet." },
    requiresTargets: false,
    parties,
    grants: [],
    canIntervene: false,
    ...overrides,
  };
}

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    userId: "u_rep",
    userName: "Riya Reporter",
    role: "reporter",
    text: `text ${id}`,
    attachments: [],
    createdAt: START,
    deletedBySender: false,
    ...overrides,
  };
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  clone: () => FakeResponse;
}
function reply(status: number, body: unknown): FakeResponse {
  const response: FakeResponse = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone: () => response,
  };
  return response;
}

type Route = (url: string, init?: RequestInit) => FakeResponse;
let routes: {
  status: Route;
  transcript: Route;
  action: Route;
  message: Route;
};
async function route(input: string, init?: RequestInit) {
  const url = String(input);
  if (url.includes("/chat/transcript")) return routes.transcript(url, init);
  if (url.endsWith("/chat/messages")) return routes.message(url, init);
  if (url.endsWith("/chat") && init?.method === "POST")
    return routes.action(url, init);
  if (url.endsWith("/chat")) return routes.status(url, init);
  throw new Error(`Unexpected fetch ${url}`);
}
const fetchMock = jest.fn();

type Call = [string, RequestInit | undefined];
const callsTo = (fragment: string, method?: string): Call[] =>
  fetchMock.mock.calls.filter(
    ([url, init]: Call) =>
      String(url).includes(fragment) &&
      (method === undefined || (init?.method ?? "GET") === method),
  );
const bodyOf = (call: Call) =>
  JSON.parse(String(call[1]?.body)) as Record<string, unknown>;

const originalFetch = global.fetch;
beforeEach(() => {
  routes = {
    status: () => reply(200, { data: chatStatus() }),
    transcript: () =>
      reply(200, {
        data: { messages: [], nextBefore: null, windowStart: START },
      }),
    action: () => reply(200, { opsActionId: "ops_1" }),
    message: () =>
      reply(200, { data: { messageId: "m_new", replayed: false } }),
  };
  fetchMock.mockReset().mockImplementation(route);
  global.fetch = fetchMock;
  mockToast.mockClear();
});
afterEach(() => {
  global.fetch = originalFetch;
  registerReauthHandler(null);
});

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <CaseChatPanel caseId="case_1" />
    </QueryClientProvider>,
  );
  return { qc, ...view };
}

function typeReason(text: string) {
  fireEvent.change(screen.getByLabelText("Reason (kept in the audit log)"), {
    target: { value: text },
  });
}

describe("CaseChatPanel eligibility", () => {
  it("shows the server's refusal and no open button when ineligible", async () => {
    routes.status = () =>
      reply(200, {
        data: chatStatus({
          channel: null,
          read: {
            ok: false,
            code: "NO_BOOKING",
            message: "This case has no linked booking.",
          },
        }),
      });
    renderPanel();
    expect(
      await screen.findByText("This case has no linked booking."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open chat (logged)" }),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when the viewer may not read chats", async () => {
    routes.status = () => reply(403, { error: "Forbidden", code: "FORBIDDEN" });
    const { container } = renderPanel();
    await waitFor(() => expect(callsTo("/chat")).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe("CaseChatPanel open read", () => {
  it("posts the reason, picked targets and withheld notice for a group chat", async () => {
    routes.status = () =>
      reply(200, {
        data: chatStatus({
          channel: { type: "team", kind: "GROUP" },
          requiresTargets: true,
        }),
      });
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open chat (logged)" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/Riya Reporter/)).not.toBeInTheDocument();
    typeReason("Reporter says host was abusive");
    const confirm = within(dialog).getByRole("button", { name: "Open chat" });
    expect(confirm).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(/Arun Attendee/));
    fireEvent.click(
      within(dialog).getByLabelText(
        "Don't tell the people in the case afterwards (only when telling would create risk)",
      ),
    );
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(callsTo("/chat", "POST")).toHaveLength(1));
    expect(bodyOf(callsTo("/chat", "POST")[0])).toEqual({
      action: "OPEN_READ",
      targetUserIds: ["u_a"],
      withholdNotice: true,
      reason: "Reporter says host was abusive",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("shows the server's refusal text inside the dialog", async () => {
    routes.action = () =>
      reply(409, { error: "Someone already has access.", code: "READ_ACTIVE" });
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open chat (logged)" }),
    );
    typeReason("Checking the claim");
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Someone already has access.",
    );
  });
});

describe("CaseChatPanel transcript", () => {
  beforeEach(() => {
    routes.status = () =>
      reply(200, { data: chatStatus({ grants: [grant({})] }) });
    routes.transcript = (url) => {
      if (url.includes("before=m_2"))
        return reply(200, {
          data: {
            messages: [
              message("m_1", {
                text: "earliest message",
                createdAt: "2026-10-20T09:01:00.000Z",
              }),
            ],
            nextBefore: null,
            windowStart: START,
          },
        });
      return reply(200, {
        data: {
          messages: [
            message("m_2", {
              userName: "Tara Target",
              role: "target",
              text: "",
              deletedBySender: true,
              createdAt: "2026-10-20T09:02:00.000Z",
            }),
            message("m_3", {
              userName: null,
              role: "support",
              text: "We are looking into this",
              attachments: [{ type: "image/png", name: "receipt.png" }],
              createdAt: "2026-10-20T09:03:00.000Z",
            }),
          ],
          nextBefore: "m_2",
          windowStart: START,
        },
      });
    };
  });

  it("renders roles, the deleted badge and attachment names only", async () => {
    const { container } = renderPanel();
    const transcript = await screen.findByRole("list", {
      name: "Chat transcript",
    });
    expect(within(transcript).getByText("Tara Target")).toBeInTheDocument();
    expect(within(transcript).getByText("Target")).toBeInTheDocument();
    expect(
      within(transcript).getByText("Deleted by sender"),
    ).toBeInTheDocument();
    expect(
      within(transcript).getAllByText("Familiarise Support").length,
    ).toBeGreaterThan(0);
    expect(
      within(transcript).getByText("Attachment: receipt.png (image/png)"),
    ).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(within(transcript).queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Role key" })).toBeInTheDocument();
    expect(
      screen.getByText(/You can read this chat until/),
    ).toBeInTheDocument();
  });

  it("loads earlier messages on demand and never refetches by itself", async () => {
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Load earlier" }),
    );
    expect(await screen.findByText("earliest message")).toBeInTheDocument();
    const transcriptCalls = callsTo("/chat/transcript");
    expect(transcriptCalls).toHaveLength(2);
    expect(String(transcriptCalls[0][0])).toBe(
      "/api/support/cases/case_1/chat/transcript?grantId=grant_1",
    );
    expect(String(transcriptCalls[1][0])).toContain("before=m_2");
    const items = within(
      screen.getByRole("list", { name: "Chat transcript" }),
    ).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("earliest message");
    expect(
      screen.queryByRole("button", { name: "Load earlier" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Access window starts/)).toBeInTheDocument();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo("/chat/transcript")).toHaveLength(2);
  });

  it("ends access with a reason", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "End access" }));
    typeReason("Finished reviewing");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "End access",
      }),
    );
    await waitFor(() => expect(callsTo("/chat", "POST")).toHaveLength(1));
    expect(bodyOf(callsTo("/chat", "POST")[0])).toEqual({
      action: "END_READ",
      grantId: "grant_1",
      reason: "Finished reviewing",
    });
  });

  it("shows an empty state", async () => {
    routes.transcript = () =>
      reply(200, {
        data: { messages: [], nextBefore: null, windowStart: START },
      });
    renderPanel();
    expect(
      await screen.findByText("No messages in the access window."),
    ).toBeInTheDocument();
  });
});

describe("CaseChatPanel intervention", () => {
  const interveneStatus = (verifiedBases: string[]) =>
    chatStatus({
      canIntervene: true,
      intervene: { ok: true, verifiedBases },
    });

  it("defaults to 72 hours, offers the asserted bases and warns when asserting", async () => {
    routes.status = () => reply(200, { data: interveneStatus([]) });
    renderPanel();
    const basis =
      await screen.findByLabelText<HTMLSelectElement>("Intervention basis");
    expect(Array.from(basis.options).map((option) => option.value)).toEqual([
      "",
      "SAFETY",
      "FRAUD_OR_SCAM",
    ]);
    expect(screen.getByLabelText("72 hours (3 days)")).toBeChecked();
    expect(screen.getByLabelText("24 hours")).not.toBeChecked();
    expect(screen.getByLabelText("168 hours (7 days)")).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Join as Familiarise Support" }),
    ).toBeDisabled();
    fireEvent.change(basis, { target: { value: "SAFETY" } });
    expect(screen.getByRole("note")).toHaveTextContent(
      "your reason is kept in the audit log",
    );
    fireEvent.click(screen.getByLabelText("168 hours (7 days)"));
    fireEvent.click(
      screen.getByRole("button", { name: "Join as Familiarise Support" }),
    );
    typeReason("Threats in the chat");
    fireEvent.click(
      screen.getByLabelText(
        "Don't tell the people in the case afterwards (only when telling would create risk)",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Join the chat" }));
    await waitFor(() => expect(callsTo("/chat", "POST")).toHaveLength(1));
    expect(bodyOf(callsTo("/chat", "POST")[0])).toEqual({
      action: "START_INTERVENTION",
      basis: "SAFETY",
      durationHours: 168,
      withholdNotice: true,
      reason: "Threats in the chat",
    });
  });

  it("pre-selects a verified basis without the assertion warning", async () => {
    routes.status = () =>
      reply(200, { data: interveneStatus(["EVIDENCE_OVERDUE"]) });
    renderPanel();
    expect(
      await screen.findByLabelText<HTMLSelectElement>("Intervention basis"),
    ).toHaveValue("EVIDENCE_OVERDUE");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Join as Familiarise Support" }),
    );
    typeReason("Evidence is late");
    fireEvent.click(screen.getByRole("button", { name: "Join the chat" }));
    await waitFor(() => expect(callsTo("/chat", "POST")).toHaveLength(1));
    expect(bodyOf(callsTo("/chat", "POST")[0])).toMatchObject({
      basis: "EVIDENCE_OVERDUE",
      durationHours: 72,
      withholdNotice: false,
    });
  });

  it("shows the server's refusal when intervention isn't allowed", async () => {
    routes.status = () =>
      reply(200, {
        data: chatStatus({
          canIntervene: true,
          intervene: {
            ok: false,
            code: "CHANNEL_FROZEN",
            message: "This chat is frozen.",
          },
        }),
      });
    renderPanel();
    expect(await screen.findByText("This chat is frozen.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Join as Familiarise Support" }),
    ).not.toBeInTheDocument();
  });
});

describe("CaseChatPanel composer", () => {
  const live = (streamJoinedAt: string | null) =>
    chatStatus({
      canIntervene: true,
      intervene: { ok: true, verifiedBases: [] },
      grants: [
        grant({
          id: "grant_iv",
          kind: "INTERVENE",
          basis: "SAFETY",
          streamJoinedAt,
        }),
      ],
    });

  it("waits for the join before posting", async () => {
    routes.status = () => reply(200, { data: live(null) });
    renderPanel();
    expect(await screen.findByText("Joining…")).toBeInTheDocument();
    expect(screen.getAllByText("Support in chat").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Message as Familiarise Support"), {
      target: { value: "Hello" },
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("posts and reuses the draft's clientActionId on retry", async () => {
    routes.status = () => reply(200, { data: live(START) });
    let attempts = 0;
    routes.message = () => {
      attempts += 1;
      return attempts === 1
        ? reply(502, { error: "Chat is unavailable.", code: "STREAM_ERROR" })
        : reply(200, { data: { messageId: "m_new", replayed: true } });
    };
    renderPanel();
    expect(await screen.findByText("Joined")).toBeInTheDocument();
    const box = screen.getByLabelText("Message as Familiarise Support");
    fireEvent.change(box, { target: { value: "  Please keep this civil  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Chat is unavailable.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(box).toHaveValue(""));
    const posts = callsTo("/chat/messages");
    expect(posts).toHaveLength(2);
    const [first, second] = posts.map(bodyOf);
    expect(first).toEqual({
      grantId: "grant_iv",
      clientActionId: expect.stringMatching(/^[A-Za-z0-9_-]{8,40}$/),
      text: "Please keep this civil",
    });
    expect(second.clientActionId).toBe(first.clientActionId);

    fireEvent.change(box, { target: { value: "Next message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callsTo("/chat/messages")).toHaveLength(3));
    expect(bodyOf(callsTo("/chat/messages")[2]).clientActionId).not.toBe(
      first.clientActionId,
    );
  });

  it("leaves the chat with a reason", async () => {
    routes.status = () => reply(200, { data: live(START) });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Leave chat" }));
    typeReason("Parties calmed down");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Leave chat",
      }),
    );
    await waitFor(() => expect(callsTo("/chat", "POST")).toHaveLength(1));
    expect(bodyOf(callsTo("/chat", "POST")[0])).toEqual({
      action: "END_INTERVENTION",
      grantId: "grant_iv",
      reason: "Parties calmed down",
    });
  });
});

describe("CaseChatPanel step-up", () => {
  it("re-authenticates on REAUTH_REQUIRED and retries the same request", async () => {
    const reauth = jest.fn().mockResolvedValue(true);
    registerReauthHandler(reauth);
    let attempts = 0;
    routes.action = () => {
      attempts += 1;
      return attempts === 1
        ? reply(403, { error: "Confirm it's you.", code: "REAUTH_REQUIRED" })
        : reply(200, { opsActionId: "ops_1" });
    };
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open chat (logged)" }),
    );
    typeReason("Checking the claim");
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(reauth).toHaveBeenCalledTimes(1);
    const posts = callsTo("/chat", "POST");
    expect(posts).toHaveLength(2);
    expect(bodyOf(posts[1])).toEqual(bodyOf(posts[0]));
  });

  it("keeps the dialog open with the server's text when re-auth is cancelled", async () => {
    registerReauthHandler(jest.fn().mockResolvedValue(false));
    routes.action = () =>
      reply(403, { error: "Confirm it's you.", code: "REAUTH_REQUIRED" });
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open chat (logged)" }),
    );
    typeReason("Checking the claim");
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Confirm it's you.",
    );
    expect(callsTo("/chat", "POST")).toHaveLength(1);
  });
});
