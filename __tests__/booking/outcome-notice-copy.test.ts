// Invariant: a proposed-verdict notice promises only what the code does. A void
// waits for its verdict's confirmation, and its 14 days run from that
// confirmation, so no notice names a date the confirmation has not fixed; a
// make-up exists for a class only.

import {
  proposedNoticeCopy,
  type ProposedNoticeInput,
} from "@/lib/booking/outcome-notice-copy";

const CLOSE = "Wed, 25 Nov 2026 · 5:15 PM IST";
const base: ProposedNoticeInput = {
  outcome: "CUT_SHORT",
  side: "learner",
  booking: "consultation",
  planTitle: "Career review",
  sessionWhen: "Mon, 23 Nov 2026 · 3:30 PM IST",
  windowClosesWhen: CLOSE,
  refund: { amountText: "₹1,500.00", destination: "you" },
  alreadyRefunded: false,
  hasRecording: false,
};
const silence = (over: Partial<ProposedNoticeInput>) =>
  proposedNoticeCopy({ ...base, ...over }).lines[1];

it("a cut-short consultation is refunded 14 days after its verdict is confirmed, with no date named", () => {
  expect(silence({})).toBe(
    `After ${CLOSE}, or sooner if you confirm it, it counts as a missed session, and we'll refund ₹1,500.00 automatically 14 days later.`,
  );
  expect(silence({ side: "host", refund: null })).toBe(
    `If nobody tells us otherwise by ${CLOSE}, it counts as a missed session, and the booking is refunded in full automatically 14 days later.`,
  );
});

it("a class's make-up window is the 14 days after the confirmation, for the seat and for the host", () => {
  expect(
    silence({
      booking: "class",
      outcome: "HOST_ABSENT",
      refund: { amountText: null, destination: "you" },
    }),
  ).toBe(
    `After ${CLOSE}, or sooner if you confirm it, it counts as a missed session: the expert then has 14 days to hold a make-up, or we'll refund it automatically.`,
  );
  expect(
    silence({ booking: "class", outcome: "HOST_ABSENT", side: "host" }),
  ).toBe(
    `If nobody tells us otherwise by ${CLOSE}, it counts as a missed session: you then have 14 days to hold a make-up, or that session is refunded automatically.`,
  );
});

it("a webinar has no make-up to promise: its seat is refunded 14 days after the confirmation", () => {
  expect(
    silence({
      booking: "webinar",
      outcome: "HOST_ABSENT",
      refund: { amountText: null, destination: "organisation" },
    }),
  ).toBe(
    `After ${CLOSE}, or sooner if you confirm it, it counts as a missed session, and we'll return it to your organisation, which paid for your seat, automatically 14 days later.`,
  );
  expect(
    silence({ booking: "webinar", outcome: "HOST_ABSENT", side: "host" }),
  ).toBe(
    `If nobody tells us otherwise by ${CLOSE}, it counts as a missed session, and each seat is refunded automatically 14 days later.`,
  );
});

it("no line of any proposed notice promises a plan session back with extra days", () => {
  for (const outcome of ["HOST_ABSENT", "CUT_SHORT"] as const) {
    for (const side of ["learner", "host"] as const) {
      const text = proposedNoticeCopy({
        ...base,
        booking: "subscription",
        outcome,
        side,
        refund: null,
      }).lines.join(" ");
      expect(text).toContain("plan");
      expect(text).not.toMatch(/extra|7 days|seven days/i);
    }
  }
});
