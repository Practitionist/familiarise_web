/**
 * The expert Home answers "what do I do now?": Needs you is ordered by urgency
 * with one button per line, the next session's Join opens at the existing
 * 15-minute window, ratings appear only once they exist, and the Requests
 * panel says a 403 is a permission problem (no Retry) and reports it once.
 */

jest.mock("next/navigation", () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { reportSentryError } from "@/lib/observability/report";
import {
  RequestsInboxPreview,
  useHomeRequests,
} from "@/components/dashboard/shared/requests/RequestsInboxPreview";
import { MoneyLine } from "../../app/dashboard/consultant/[consultantId]/(features)/home/MoneyLine";
import { NeedsYou } from "../../app/dashboard/consultant/[consultantId]/(features)/home/NeedsYou";
import { NextSession } from "../../app/dashboard/consultant/[consultantId]/(features)/home/NextSession";
import {
  deriveGlanceRows,
  deriveHomeNeedsYou,
  deriveHomeSessions,
  deriveMoneyLine,
  deriveRatingParts,
  type NeedsYouRow,
} from "../../app/dashboard/consultant/[consultantId]/(features)/home/home-model";
import type { TAppointment } from "@/types/appointment";

const CP = "cp-1";
const BASE = `/dashboard/consultant/${CP}`;
const NOW = new Date("2026-11-09T09:00:00Z");
const ZONE = { zone: "Asia/Kolkata", own: true };
const minutesFromNow = (m: number) => new Date(NOW.getTime() + m * 60_000);
const hoursFromNow = (h: number) => minutesFromNow(h * 60);

function requestRow(
  id: string,
  name: string,
  deadline: Date | null,
  extra: Partial<NeedsYouRow> = {},
): NeedsYouRow {
  return {
    id,
    requester: { name, image: null },
    planTitle: "Career chat",
    deadline,
    bucket: "this-week",
    checkoutHold: null,
    requestedStartPassed: false,
    ...extra,
  };
}

const needsInput = {
  requestRows: undefined as readonly NeedsYouRow[] | undefined,
  needsYou: undefined,
  payoutSetup: undefined,
  unreadMessages: 0,
  basePath: BASE,
  viewerZone: ZONE,
  now: NOW,
};

describe("Needs you ordering", () => {
  it("puts requests by deadline first, then payout setup, then messages", () => {
    const items = deriveHomeNeedsYou({
      ...needsInput,
      requestRows: [
        requestRow("late", "Later Lena", hoursFromNow(30)),
        requestRow("soon", "Soon Sam", hoursFromNow(3)),
      ],
      needsYou: {
        requestsToAnswer: 2,
        rescheduleReplies: [],
        owedMakeUps: [],
        documentsAwaitingReview: 0,
        collabInvites: 0,
        reviewsToReply: 0,
      },
      payoutSetup: {
        needed: true,
        href: `${BASE}/settings/get-paid`,
        livePayoutsEnabled: true,
      },
      unreadMessages: 4,
    });
    expect(items.map((i) => i.key)).toEqual([
      "request:soon",
      "request:late",
      "payout-setup",
      "unread-messages",
    ]);
    expect(items[0].detail).toMatch(/^Reply by /);
    expect(items[0].href).toBe(`${BASE}/requests?focus=soon`);
  });

  it("puts a decision with a deadline ahead of an untimed request and caps at five", () => {
    const items = deriveHomeNeedsYou({
      ...needsInput,
      requestRows: [
        requestRow("a", "A", null),
        requestRow("b", "B", null),
        requestRow("c", "C", null),
      ],
      needsYou: {
        requestsToAnswer: 6,
        rescheduleReplies: [{ appointmentId: "ap1", counterpartName: "Ravi" }],
        owedMakeUps: [
          {
            appointmentId: "ap2",
            occurrenceId: "oc2",
            title: "Yoga",
            deadline: hoursFromNow(48).toISOString(),
          },
        ],
        documentsAwaitingReview: 2,
        collabInvites: 0,
        reviewsToReply: 0,
      },
      payoutSetup: {
        needed: true,
        href: `${BASE}/settings/get-paid`,
        livePayoutsEnabled: true,
      },
      unreadMessages: 1,
    });
    expect(items).toHaveLength(5);
    expect(items[0].key).toBe("make-up:oc2");
    expect(items[0].detail).toMatch(/^Hold it by /);
    expect(items[1].key).toBe("reschedule-reply:ap1");
    expect(items.map((i) => i.key)).not.toContain("unread-messages");
  });

  it("folds requests beyond three into one line and skips rows the learner owns", () => {
    const items = deriveHomeNeedsYou({
      ...needsInput,
      requestRows: [
        requestRow("w", "Waiting", null, { bucket: "waiting-on-them" }),
        requestRow("h", "Paying", null, {
          checkoutHold: { expiresAt: hoursFromNow(1) },
        }),
        requestRow("1", "One", null),
      ],
      needsYou: {
        requestsToAnswer: 4,
        rescheduleReplies: [],
        owedMakeUps: [],
        documentsAwaitingReview: 0,
        collabInvites: 0,
        reviewsToReply: 0,
      },
    });
    expect(items.map((i) => i.text)).toEqual([
      "One · Career chat",
      "3 more requests to answer",
    ]);
  });

  it("falls back to the count line while the inbox has not loaded", () => {
    const items = deriveHomeNeedsYou({
      ...needsInput,
      needsYou: {
        requestsToAnswer: 2,
        rescheduleReplies: [],
        owedMakeUps: [],
        documentsAwaitingReview: 0,
        collabInvites: 0,
        reviewsToReply: 0,
      },
    });
    expect(items.map((i) => i.text)).toEqual(["2 requests to answer"]);
  });
});

describe("NeedsYou render", () => {
  it("says so once, in one quiet line, when nothing waits", () => {
    render(<NeedsYou items={[]} />);
    expect(
      screen.getByRole("heading", { name: "Needs you" }),
    ).toBeInTheDocument();
    expect(screen.getByText("You're all caught up.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("gives each item exactly one named action", () => {
    render(
      <NeedsYou
        items={[
          {
            key: "a",
            text: "Priya · Career chat",
            detail: "Reply by Tue",
            ctaLabel: "Answer",
            href: `${BASE}/requests?focus=a`,
          },
          {
            key: "b",
            text: "2 unread messages",
            ctaLabel: "Open",
            href: `${BASE}/messages`,
          },
        ]}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(within(row).getAllByRole("link")).toHaveLength(1);
    }
    expect(
      screen.getByRole("link", { name: "Answer: Priya · Career chat" }),
    ).toHaveAttribute("href", `${BASE}/requests?focus=a`);
  });
});

function consultation(id: string, name: string, slots: [Date, Date][]) {
  return {
    id,
    appointmentType: "CONSULTATION",
    organizationId: null,
    occurrences: slots.map(([startsAt, endsAt], i) => ({
      id: `${id}-o${i}`,
      startsAt,
      endsAt,
      isTentative: false,
      completionStatus: "SCHEDULED",
      deletedAt: null,
      meeting: null,
    })),
    consultation: {
      status: "APPROVED",
      consultationPlan: { title: "Career chat", consultantProfileId: CP },
      requestedBy: { id: "ce", user: { name, image: null } },
    },
  } as unknown as TAppointment;
}

function renderNext(
  appointments: TAppointment[],
  now = NOW,
  onJoin = jest.fn(),
) {
  const sessions = deriveHomeSessions(appointments, CP, now);
  render(
    <NextSession
      sessions={sessions}
      consultantId={CP}
      viewerZone={ZONE}
      now={now}
      onJoin={onJoin}
    />,
  );
  return { sessions, onJoin };
}

describe("Next session", () => {
  it("disables Join until 15 minutes before the start and names when it opens", () => {
    // Starts 16 minutes out: the window opens at 09:01Z = 14:31 IST.
    renderNext([
      consultation("a1", "Priya Nair", [
        [minutesFromNow(16), minutesFromNow(76)],
      ]),
    ]);
    const join = screen.getByRole("button", { name: "Join at 2:31 PM" });
    expect(join).toBeDisabled();
    expect(screen.getByText("Priya Nair")).toBeInTheDocument();
    expect(screen.getByText(/1 h/)).toBeInTheDocument();
  });

  it("enables Join inside the window and joins the occurrence", () => {
    const { sessions, onJoin } = renderNext([
      consultation("a1", "Priya Nair", [
        [minutesFromNow(14), minutesFromNow(74)],
      ]),
    ]);
    const join = screen.getByRole("button", { name: "Join" });
    expect(join).toBeEnabled();
    join.click();
    expect(onJoin).toHaveBeenCalledWith(sessions[0]);
  });

  it("keeps an unconfirmed booking out of the card", () => {
    const pending = consultation("a1", "Priya", [
      [minutesFromNow(5), minutesFromNow(65)],
    ]);
    (
      pending as unknown as { consultation: { status: string } }
    ).consultation.status = "APPROVED_PENDING_PAYMENT";
    renderNext([pending]);
    expect(screen.getByText(/Nothing booked/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Set your availability" }),
    ).toHaveAttribute("href", `${BASE}/availability`);
  });

  it("lists the next three sessions on one Then line", () => {
    renderNext([
      consultation("a1", "First", [[hoursFromNow(2), hoursFromNow(3)]]),
      consultation("a2", "Second", [[hoursFromNow(26), hoursFromNow(27)]]),
      consultation("a3", "Third", [[hoursFromNow(50), hoursFromNow(51)]]),
      consultation("a4", "Fourth", [[hoursFromNow(74), hoursFromNow(75)]]),
      consultation("a5", "Fifth", [[hoursFromNow(98), hoursFromNow(99)]]),
    ]);
    const then = screen.getByText("Then:").closest("p");
    expect(then).not.toBeNull();
    const text = then?.textContent ?? "";
    expect(text).toContain("Second");
    expect(text).toContain("Fourth");
    expect(text).not.toContain("Fifth");
    expect(text).not.toContain("First");
  });
});

describe("ratings and money", () => {
  it("shows no rating until one exists", () => {
    expect(
      deriveRatingParts({
        publishedRatingOneToOne: null,
        publishedRatingGroup: null,
        ratedClientsOneToOne: 0,
        ratedEventsGroup: 0,
      }),
    ).toEqual([]);
    render(
      <MoneyLine
        consultantId={CP}
        moneyLine="Nothing ready to pay out yet"
        sessionsThisMonth={0}
        ratingParts={[]}
      />,
    );
    expect(screen.queryByText(/—/)).toBeNull();
    expect(screen.queryByRole("link", { name: /Reviews/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Earnings/ })).toBeInTheDocument();
  });

  it("states a rating with its count once it exists", () => {
    const parts = deriveRatingParts({
      publishedRatingOneToOne: 4.8,
      publishedRatingGroup: null,
      ratedClientsOneToOne: 12,
      ratedEventsGroup: 0,
    });
    expect(parts).toEqual(["4.8 from 12 learners"]);
    render(
      <MoneyLine
        consultantId={CP}
        moneyLine="x"
        sessionsThisMonth={3}
        ratingParts={parts}
      />,
    );
    expect(
      screen.getByText(/3 sessions this month · 4\.8 from 12 learners/),
    ).toBeInTheDocument();
  });

  it("words the money line from the payout state", () => {
    const base = { availablePaise: 202929, now: NOW };
    expect(
      deriveMoneyLine({
        ...base,
        payoutSetup: { needed: false, href: "", livePayoutsEnabled: true },
      }),
    ).toMatch(/^₹2,029\.29 ready · next payout \w{3} \d{1,2} \w{3}$/);
    expect(
      deriveMoneyLine({
        ...base,
        payoutSetup: { needed: true, href: "", livePayoutsEnabled: true },
      }),
    ).toBe("₹2,029.29 ready · add a bank account to get paid");
    expect(
      deriveMoneyLine({
        availablePaise: 0,
        now: NOW,
        payoutSetup: { needed: false, href: "", livePayoutsEnabled: true },
      }),
    ).toBe("Nothing ready to pay out yet");
  });

  it("leaves zero-valued glance rows out", () => {
    expect(
      deriveGlanceRows({
        sessions: [],
        sessionsDelivered: { thisMonth: 0, lifetime: 0 },
        responseRate: { withinTarget: 0, total: 0, withinTargetPct: null },
        now: NOW,
      }),
    ).toEqual([]);
  });
});

function RequestsHarness() {
  const query = useHomeRequests(CP);
  return <RequestsInboxPreview consultantProfileId={CP} query={query} />;
}

function renderRequests() {
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RequestsHarness />
    </QueryClientProvider>,
  );
}

/** jsdom has no Response; the hook reads only ok, status and json(). */
const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("Requests panel errors", () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it("says a 403 is about access, offers no Retry, and reports once", async () => {
    fetchMock.mockResolvedValue(reply(403, { error: "Access denied" }));
    renderRequests();
    expect(
      await screen.findByText("You don't have access to these requests."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(/Access denied/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(reportSentryError).toHaveBeenCalledTimes(1));
  });

  it("shows friendly copy and Retry for a server fault, never the server's words", async () => {
    fetchMock.mockResolvedValue(
      reply(500, {
        error: "An error occurred while fetching the requests inbox",
      }),
    );
    renderRequests();
    expect(
      await screen.findByText("Couldn't load requests. Try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText(/An error occurred/)).toBeNull();
    expect(reportSentryError).not.toHaveBeenCalled();
  });
});
