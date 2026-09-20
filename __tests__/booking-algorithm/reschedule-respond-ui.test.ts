/**
 * #1163 / #1169 PR 4b (UI half) — the respond endpoint has UI callers, and
 * withdraw has one. Source contracts: these assert the wiring that turns the
 * API loop shipped in PR 4a into something a consultee can actually click.
 */

import fs from "fs";
import path from "path";
import { requestCountLine } from "@/components/dashboard/shared/requests/request-count-line";
import { subscriptionEntitlement } from "@/lib/booking/entitlement";

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const proposalCard = read(
  "components/appointments/detail/RescheduleProposalCard.tsx",
);
const detailClient = read(
  "components/appointments/detail/AppointmentDetailClient.tsx",
);
const adapter = read(
  "components/appointments/consultee/ConsulteeAppointmentsAdapter.tsx",
);
const eventActions = read(
  "components/appointments/consultee/useEventActions.ts",
);
// #1775 — the Requests tab became the inbox: the row decides, the inbox calls.
const inbox = read("components/dashboard/shared/requests/RequestsInbox.tsx");
const inboxRow = read("components/dashboard/shared/requests/InboxRow.tsx");
const inboxRead = read("lib/data/requests-inbox.ts");
// #1675 — the decline call moved into the module both surfaces share.
const requestDecision = read(
  "components/dashboard/shared/requests/request-decision.ts",
);
const reschedulePage = read(
  "app/dashboard/consultee/[consulteeId]/(features)/appointments/[appointmentId]/reschedule/page.tsx",
);

describe("#1163 — the proposal card answers through the lifecycle endpoints", () => {
  it("calls respond with an action and withdraw without one", () => {
    expect(proposalCard).toContain("/reschedule/respond");
    expect(proposalCard).toContain("/reschedule/withdraw");
    expect(proposalCard).toContain("JSON.stringify({ action: kind })");
  });

  it("splits the affordances by identity: counterparty answers, initiator withdraws", () => {
    expect(proposalCard).toContain("proposal.initiatedById");
    expect(proposalCard).toContain('mutation.mutate("withdraw")');
    expect(proposalCard).toContain('mutation.mutate("accept")');
    expect(proposalCard).toContain('mutation.mutate("decline")');
  });

  it("decline confirms first and says the booking is not being cancelled", () => {
    expect(proposalCard).toContain("not");
    expect(proposalCard).toContain("cancelling the booking");
    expect(proposalCard).toContain("AlertDialog");
  });

  it("invalidates the detail and events caches and relays the server message", () => {
    expect(proposalCard).toContain('["appointment-detail", appointmentId]');
    expect(proposalCard).toContain('["consultee-events"]');
    expect(proposalCard).toContain("description: data.message");
  });

  it("mounts on the shared detail page off the live rescheduleRequests read", () => {
    expect(detailClient).toContain("RescheduleProposalCard");
    expect(detailClient).toContain("rescheduleRequests?.[0]");
  });
});

describe("#1163 — the consultee list surfaces the proposal", () => {
  it("the adapter navigates to the appointment CARRYING the proposal", () => {
    expect(adapter).toContain("openProposalTarget");
    expect(adapter).toContain("groupAppointments");
    expect(adapter).toContain("proposalTarget.appointmentId");
  });
});

describe("#1163 — cancel/reschedule invalidation reaches the detail hub", () => {
  it("useEventActions always invalidates appointment-detail", () => {
    expect(eventActions).toContain('["appointment-detail", appointmentId]');
  });

  it("the adapter threads its resolved consulteeId instead of trusting useParams", () => {
    expect(eventActions).toContain("consulteeIdOverride");
    // The adapter passes the id it resolved (options → params → session).
    expect(adapter).toMatch(
      /useEventActions\(\{[\s\S]*?consulteeId,[\s\S]*?\}\)/,
    );
  });
});

describe("#1163 — the consultant inbox answers proposals", () => {
  it("Approve routes an answerable proposal through respond-accept", () => {
    expect(inbox).toContain("answerableProposal");
    expect(inbox).toContain("/reschedule/respond");
    expect(inbox).toContain('action: "accept"');
    // The suppression is lifted BY the proposal, not removed outright.
    expect(inboxRow).toContain("rescheduledSlotCount === 0");
  });

  it("only a PENDING_REVIEW consultee-initiated proposal with times is answerable", () => {
    expect(inboxRow).toContain('p?.status !== "PENDING_REVIEW"');
    expect(inboxRow).toContain('p.initiatorRole !== "CONSULTEE"');
    expect(inboxRow).toContain("t.round === p.round).length === 0");
  });

  it("decline is confirmed, covers subscriptions, and disables in flight", () => {
    expect(inbox).toContain(
      "declineRequest({ id: row.id, type: requestType(row) })",
    );
    expect(requestDecision).toContain("/api/bookings/subscriptions/");
    expect(requestDecision).toContain('JSON.stringify({ status: "REJECTED" })');
    expect(inbox).toContain("decline.isPending");
    expect(inbox).toContain("AlertDialog");
  });
});

describe("#1163 — the reschedule page refuses trial subjects", () => {
  it("renders a friendly refusal instead of a picker that 403s at submit", () => {
    expect(reschedulePage).toContain('appointmentType === "TRIAL"');
    expect(reschedulePage).toContain("can&apos;t be rescheduled");
  });
});

describe("#1766 — the Requests inbox sizes a subscription's batch off the entitlement", () => {
  it("asks for this cycle's nextBatch, never the lifetime total", () => {
    // The requiredSlots arm for a fresh subscription (no tentative rows).
    const arm = inboxRead.slice(
      inboxRead.indexOf("const freshBatch ="),
      inboxRead.indexOf(
        "return finish(",
        inboxRead.indexOf("const freshBatch ="),
      ),
    );
    expect(arm).toContain("entitlement.cycle.nextBatch * slotsPerSession");
    expect(arm).not.toContain("totalSessions * slotsPerSession");
    expect(inboxRead).toContain("sessionsTotalOf(s)");
    expect(inboxRead).not.toContain("countSundayWeeksInclusive");
  });
});

describe("#1766 — the Requests list row reads entitlement words", () => {
  it("says booked-of-total and the pick, never a bare slot count, for a subscription", () => {
    const entitlement = subscriptionEntitlement({
      sessionsTotal: 12,
      sessionsPerWeek: 4,
      durationInMonths: 3,
      occurrences: [],
      schedulingPeriodStartsAt: new Date("2026-03-02T00:00:00Z"),
      schedulingTimezone: "UTC",
    });
    expect(requestCountLine({ entitlement })).toBe("0 of 12 booked · pick 4");
    // The row renders through the helper, not an inline slot count.
    expect(inboxRow).toContain(
      "requestCountLine({ entitlement: row.entitlement })",
    );
    expect(inboxRow).not.toContain("to allocate");
  });
});
