/**
 * @jest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";

const toast = jest.fn();
jest.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { ActiveCollaborationCard } from "@/components/collaborators/ActiveCollaborationCard";
import { CollaboratorsTab } from "@/components/collaborators/CollaboratorsTab";
import { EndCollaborationDialog } from "@/components/collaborators/EndCollaborationDialog";
import { InviteDialog } from "@/components/collaborators/InviteDialog";
import { PendingInvitationCard } from "@/components/collaborators/PendingInvitationCard";
import type {
  CollaborationWithPlan,
  TeamMember,
} from "@/components/collaborators/types";
import {
  inviteCollaboratorSchemas,
  respondToInvitationSchema,
} from "@/schemas/collaborators";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

type Call = { url: string; method: string; body: unknown };
type Answer = { status: number; body: unknown };
let calls: Call[] = [];
/** Answers by `METHOD url`; a queue per key, the last answer repeating. */
let answers: Record<string, Answer[]> = {};

const writes = () => calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  calls = [];
  answers = {};
  toast.mockClear();
  globalThis.ResizeObserver = NoopResizeObserver;
  window.matchMedia = (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  });
  globalThis.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      const queue = answers[`${method} ${url}`] ?? [];
      const answer = (queue.length > 1 ? queue.shift() : queue[0]) ?? {
        status: 200,
        body: { data: {} },
      };
      return {
        ok: answer.status < 400,
        status: answer.status,
        json: async () => answer.body,
      };
    },
  ) as unknown as typeof fetch;
});

function show(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  id: "collab-2",
  role: "MODERATOR",
  status: "ACCEPTED",
  revenueShareBps: 1500,
  expiresAt: null,
  consultantProfile: { id: "profile-3", user: { name: "Arjun", image: null } },
  ...over,
});

/** The viewer's own row as `GET /api/collaborations` sends it: a ₹10,000 webinar at 25%. */
const invitation = (
  over: Partial<CollaborationWithPlan> = {},
): CollaborationWithPlan => ({
  id: "collab-1",
  role: "CO_HOST",
  revenueShareBps: 2500,
  status: "PENDING",
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  payoutAccountReady: true,
  webinarPlan: {
    id: "plan-1",
    title: "Intro to SIPs",
    price: 1_000_000,
    durationInHours: 1,
    maxParticipants: 50,
    language: null,
    level: null,
    webinars: [],
    consultantProfile: {
      id: "profile-1",
      user: { name: "Hannah", image: null },
    },
    // A peer's share is withheld by the server.
    collaborators: [member({ revenueShareBps: null })],
  },
  invitedBy: { user: { name: "Hannah" } },
  planType: "webinar",
  planId: "plan-1",
  planTitle: "Intro to SIPs",
  planPrice: 1_000_000,
  ...over,
});

const RESPOND = "PATCH /api/collaborations/collab-1/respond";

it("an invitation states the role, the rupee share and the lapse date, and accepting sends the terms on screen", async () => {
  show(<PendingInvitationCard collab={invitation()} />);

  expect(screen.getByText("Co-host.")).toBeInTheDocument();
  expect(
    screen.getByText(/Presents with the host and can record or end/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      /At the listed price of ₹10,000\.00, ₹2,500\.00 of each seat is your share before the platform fee/,
    ),
  ).toBeInTheDocument();
  expect(screen.getByText(/^15 November 2026\./)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Accept…" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("25%")).toBeInTheDocument();
  expect(writes()).toHaveLength(0);

  fireEvent.click(
    within(dialog).getByRole("button", { name: "Accept and join" }),
  );
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(respondToInvitationSchema.parse(writes()[0].body)).toEqual({
    response: "ACCEPTED",
    seenTerms: { role: "CO_HOST", sharePercent: 25 },
  });
});

it("when the host changed the terms, the card shows the new ones, says so, and the next accept sends them", async () => {
  answers[RESPOND] = [
    {
      status: 409,
      body: {
        error:
          "The host changed this invitation's terms. Review the new terms before accepting.",
        code: "TERMS_CHANGED",
        terms: { role: "MODERATOR", sharePercent: 5 },
      },
    },
    { status: 200, body: { data: { id: "collab-1" } } },
  ];
  show(<PendingInvitationCard collab={invitation()} />);

  fireEvent.click(screen.getByRole("button", { name: "Accept…" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Accept and join" }),
  );

  expect(
    await within(dialog).findByText(
      /The host changed this invitation's terms\. Review the new terms/,
    ),
  ).toBeInTheDocument();
  expect(within(dialog).getByText("Moderator.")).toBeInTheDocument();
  expect(within(dialog).getByText("5%")).toBeInTheDocument();
  expect(within(dialog).queryByText("25%")).toBeNull();
  expect(
    screen.getByText(/The host changed this invitation after it was sent/),
  ).toBeInTheDocument();

  fireEvent.click(
    within(dialog).getByRole("button", { name: "Accept and join" }),
  );
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(respondToInvitationSchema.parse(writes()[1].body)).toEqual({
    response: "ACCEPTED",
    seenTerms: { role: "MODERATOR", sharePercent: 5 },
  });
});

it("a decline is confirmed with what it costs, and a refused one shows the server's reason", async () => {
  answers[RESPOND] = [
    {
      status: 409,
      body: {
        error: "This invitation is no longer open.",
        code: "NOT_PENDING",
      },
    },
  ];
  show(<PendingInvitationCard collab={invitation()} />);
  fireEvent.click(screen.getByRole("button", { name: "Decline…" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("cannot invite you again for 7 days");
  expect(writes()).toHaveLength(0);

  fireEvent.click(within(dialog).getByRole("button", { name: "Decline" }));
  expect(
    await within(dialog).findByText("This invitation is no longer open."),
  ).toBeInTheDocument();
  expect(writes()[0].body).toEqual({ response: "DECLINED" });
});

it("a plan the viewer helps deliver lists peers by name and role with no share, and links to nobody's dashboard", () => {
  const { container } = show(
    <ActiveCollaborationCard collab={invitation({ status: "ACCEPTED" })} />,
  );
  const peer = screen.getByText("Arjun").closest("li");
  expect(peer).toHaveTextContent("Moderator");
  expect(peer).not.toHaveTextContent("%");
  expect(
    container.querySelector('a[href*="/dashboard/consultant/"]'),
  ).toBeNull();
  // The viewer's own share is the only one on the card.
  expect(screen.getByText("25%")).toBeInTheDocument();
});

it("removing a collaborator says what happens to access and to money before it deletes", async () => {
  show(
    <EndCollaborationDialog
      kind="remove"
      planRef={{ planType: "webinar", planId: "plan-1" }}
      planTitle="Intro to SIPs"
      collaboratorId="collab-2"
      personName="Arjun"
      trigger={<button type="button">Remove</button>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("Arjun's access ends now");
  expect(dialog).toHaveTextContent(
    "Seats sold while they were on the team keep their split",
  );
  expect(dialog).toHaveTextContent(
    "Seats sold from now on do not include them",
  );
  expect(writes()).toHaveLength(0);

  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toMatchObject({
    method: "DELETE",
    url: "/api/collaborations/webinar/plan-1/collab-2",
  });
});

it("a pending invitation is cancelled in other words: no access or money was ever involved", async () => {
  show(
    <EndCollaborationDialog
      kind="cancel"
      planRef={{ planType: "webinar", planId: "plan-1" }}
      planTitle="Intro to SIPs"
      collaboratorId="collab-2"
      personName="Arjun"
      trigger={<button type="button">Cancel invitation</button>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel invitation" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent(
    "Arjun has not accepted, so they have no access",
  );
  expect(dialog).not.toHaveTextContent("access ends now");
});

it("the editor tab says a failed load failed, and loads on a second try", async () => {
  const url = "GET /api/collaborations/webinar/plan-1";
  answers[url] = [
    { status: 500, body: { error: "Something went wrong. Please try again." } },
    { status: 200, body: { data: [], viewer: "manager", canManage: true } },
  ];
  show(
    <CollaboratorsTab
      planType="webinar"
      planId="plan-1"
      planTitle="Intro to SIPs"
      planPricePaise={1_000_000}
    />,
  );
  expect(
    await screen.findByText("Couldn't load this plan's collaborators"),
  ).toBeInTheDocument();
  expect(screen.queryByText("No collaborators yet")).toBeNull();
  expect(screen.queryByRole("button", { name: /Invite/ })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No collaborators yet")).toBeInTheDocument();
  expect(screen.getByText(/You keep 100% of each seat/)).toBeInTheDocument();
});

it("an invite is found by keyboard, reviewed with a rupee example, then sent as the route accepts it; a refusal says what is left", async () => {
  answers["GET /api/consultants/search?q=pri"] = [
    {
      status: 200,
      body: {
        data: [{ id: "profile-2", user: { name: "Priya", image: null } }],
      },
    },
  ];
  answers["POST /api/collaborations/webinar/plan-1"] = [
    {
      status: 409,
      body: {
        error: "Collaborators can share at most 90% of a plan between them.",
        code: "SHARES_EXCEEDED",
        availablePercent: 20,
      },
    },
  ];
  show(
    <InviteDialog
      planRef={{ planType: "webinar", planId: "plan-1" }}
      planTitle="Intro to SIPs"
      planPricePaise={1_000_000}
      team={[member()]}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Invite a collaborator" }),
  );
  const dialog = await screen.findByRole("dialog");
  const review = within(dialog).getByRole("button", {
    name: "Review invitation",
  });
  expect(review).toBeDisabled();

  const search = within(dialog).getByRole("combobox", { name: "Expert" });
  fireEvent.focus(search);
  fireEvent.change(search, { target: { value: "pri" } });
  expect(
    await within(dialog).findByText("1 expert found."),
  ).toBeInTheDocument();
  expect(search).toHaveAttribute("aria-expanded", "true");
  fireEvent.keyDown(search, { key: "Enter" });
  expect(within(dialog).getByText("Priya")).toBeInTheDocument();

  // An option also answers a key pressed on it, for a screen reader's own cursor.
  fireEvent.click(within(dialog).getByRole("button", { name: /Change/ }));
  const again = within(dialog).getByRole("combobox", { name: "Expert" });
  fireEvent.focus(again);
  fireEvent.change(again, { target: { value: "pri" } });
  fireEvent.keyDown(await within(dialog).findByRole("option"), { key: " " });
  expect(
    within(dialog).queryByRole("combobox", { name: "Expert" }),
  ).not.toBeInTheDocument();
  expect(within(dialog).getByText("Priya")).toBeInTheDocument();

  fireEvent.click(within(dialog).getByRole("radio", { name: "Co-host" }));
  fireEvent.change(
    within(dialog).getByLabelText("Their share of each seat (%)"),
    { target: { value: "25" } },
  );
  expect(
    within(dialog).getByText(/Collaborators would hold 40% of this plan/),
  ).toBeInTheDocument();
  expect(review).toBeEnabled();
  fireEvent.click(review);

  expect(
    await within(dialog).findByText(
      /₹2,500\.00 of each seat is their share, ₹1,500\.00 goes to your other collaborators and ₹6,000\.00 stays with you, before the platform fee/,
    ),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(/collaborators hold 40% of this plan/),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(/The invitation lapses on/),
  ).toBeInTheDocument();
  expect(writes()).toHaveLength(0);

  fireEvent.click(
    within(dialog).getByRole("button", { name: "Send invitation" }),
  );
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(inviteCollaboratorSchemas.webinar.parse(writes()[0].body)).toEqual({
    consultantProfileId: "profile-2",
    role: "CO_HOST",
    sharePercent: 25,
  });
  expect(
    await within(dialog).findByText(
      "Collaborators can share at most 90% of a plan between them. 20% is still free on this plan.",
    ),
  ).toBeInTheDocument();
});
