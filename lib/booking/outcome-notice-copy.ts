/**
 * The words of the two session-outcome notices, shared by the bell and the email
 * so both say the same thing. Pure: every date and amount arrives already
 * formatted in the recipient's own zone and currency.
 */
import type { OccurrenceOutcome } from "@prisma/client";

import type { NegativeMoneyOutcome } from "./misses";

export type NoticeSide = "host" | "learner";

export type NoticeBooking =
  "consultation" | "subscription" | "trial" | "class" | "webinar";

export interface NoticeCopy {
  subject: string;
  lines: string[];
  actionLabel: string;
}

export interface ProposedNoticeInput {
  outcome: NegativeMoneyOutcome;
  side: NoticeSide;
  booking: NoticeBooking;
  planTitle: string;
  /** The session's start, in the recipient's zone. */
  sessionWhen: string;
  /** `outcomeAt` + the report window, in the recipient's zone. */
  windowClosesWhen: string;
  /** `outcomeAt` + the 14-day make-up window, when a void's refund falls due, in the recipient's zone. */
  makeUpByWhen: string;
  /** The consultation's refundable balance, formatted from paise; null when nothing was paid. */
  refundText: string | null;
  hasRecording: boolean;
}

const SUBJECT: Record<NegativeMoneyOutcome, Record<NoticeSide, string>> = {
  HOST_ABSENT: {
    learner: "We recorded that your expert didn't join",
    host: "We recorded that you didn't join your session",
  },
  CUT_SHORT: {
    learner: "We recorded your session as cut short",
    host: "We recorded your session as cut short",
  },
  LEARNER_ABSENT: {
    learner: "We didn't see you in your session",
    host: "We recorded that your participant didn't join",
  },
};

const RECORDED: Record<NegativeMoneyOutcome, Record<NoticeSide, string>> = {
  HOST_ABSENT: {
    learner: "shows the expert didn't join",
    host: "shows you didn't join",
  },
  CUT_SHORT: {
    learner: "shows the expert left too early for it to count as held",
    host: "shows you left too early for it to count as held",
  },
  LEARNER_ABSENT: {
    learner: "shows you didn't join",
    host: "shows the participant didn't join",
  },
};

/** What a void does once confirmed, by the kind of booking: the settle sweep refunds it after the make-up window. */
function voidRemedy(input: ProposedNoticeInput, side: NoticeSide): string {
  const by = input.makeUpByWhen;
  switch (input.booking) {
    case "subscription":
      return side === "learner"
        ? "the session goes back to your plan's allowance"
        : "the session goes back to the learner's plan allowance";
    case "trial":
      return "the session won't count as held";
    case "consultation":
      if (side === "host") {
        return `it counts as a missed session, and the learner is refunded in full automatically after ${by}`;
      }
      return input.refundText
        ? `it counts as a missed session, and we'll refund ${input.refundText} automatically after ${by}`
        : "it counts as a missed session";
    case "class":
    case "webinar":
      return side === "learner"
        ? `it counts as a missed session: the expert has until ${by} to hold a make-up, or that session is refunded to you automatically`
        : `it counts as a missed session: hold a make-up by ${by}, or that session is refunded to your learners automatically`;
  }
}

function learnerSilence(input: ProposedNoticeInput): string {
  const close = input.windowClosesWhen;
  if (input.outcome === "LEARNER_ABSENT") {
    return `If nobody tells us otherwise by ${close}, it counts as held and isn't refunded.`;
  }
  if (input.outcome === "HOST_ABSENT" && input.booking === "consultation") {
    return input.refundText
      ? `We'll refund ${input.refundText} automatically after ${close}, or sooner if you confirm the expert didn't join.`
      : `We'll cancel the session automatically after ${close}, or sooner if you confirm the expert didn't join.`;
  }
  return `After ${close}, or sooner if you confirm it, ${voidRemedy(input, "learner")}.`;
}

function hostSilence(input: ProposedNoticeInput): string {
  const lead = `If nobody tells us otherwise by ${input.windowClosesWhen},`;
  if (input.outcome === "LEARNER_ABSENT") {
    return `${lead} it counts as held and your fee for it stays with you.`;
  }
  if (input.outcome === "HOST_ABSENT" && input.booking === "consultation") {
    return `${lead} the learner is refunded in full and the miss is added to your reliability record, which only you and our team see.`;
  }
  return `${lead} ${voidRemedy(input, "host")}.`;
}

/** The notice both sides get when the sweep proposes a negative verdict. */
export function proposedNoticeCopy(input: ProposedNoticeInput): NoticeCopy {
  const { outcome, side } = input;
  const lines = [
    `Our record of your ${input.sessionWhen} session of ${input.planTitle} ${RECORDED[outcome][side]}.`,
    side === "learner" ? learnerSilence(input) : hostSilence(input),
    "If the call record is incomplete, our team checks it before anything is applied.",
    "Use the link to confirm this or to tell us what happened.",
  ];
  if (input.hasRecording && outcome === "LEARNER_ABSENT" && side === "learner") {
    lines.push("The session's recording is in your library.");
  }
  return { subject: SUBJECT[outcome][side], lines, actionLabel: "Report a problem" };
}

export interface ReviewedNoticeInput {
  outcome: OccurrenceOutcome;
  side: NoticeSide;
  planTitle: string;
  sessionWhen: string;
}

const NOW_SHOWS: Record<OccurrenceOutcome, Record<NoticeSide, string>> = {
  HELD: { learner: "it was held", host: "it was held" },
  HOST_ABSENT: {
    learner: "the expert didn't join",
    host: "you didn't join",
  },
  CUT_SHORT: {
    learner: "it ended too early to count as held",
    host: "it ended too early to count as held",
  },
  LEARNER_ABSENT: {
    learner: "you didn't join",
    host: "the participant didn't join",
  },
  PLATFORM_OUTAGE: {
    learner: "a problem on our side stopped it, so it doesn't count against anyone",
    host: "a problem on our side stopped it, so it doesn't count against anyone",
  },
  NOBODY_JOINED: { learner: "nobody joined it", host: "nobody joined it" },
  INCONCLUSIVE: {
    learner: "we can't tell what happened, and our team will follow up",
    host: "we can't tell what happened, and our team will follow up",
  },
  OFFLINE: {
    learner: "it didn't run on our platform, and our team will follow up",
    host: "it didn't run on our platform, and our team will follow up",
  },
};

/** The one short notice both sides get when ops change a negative verdict. */
export function reviewedNoticeCopy(input: ReviewedNoticeInput): NoticeCopy {
  return {
    subject: "We've reviewed your session",
    lines: [
      `We've reviewed your ${input.sessionWhen} session of ${input.planTitle}. Our record now shows ${NOW_SHOWS[input.outcome][input.side]}.`,
      "The booking shows what this means for it.",
    ],
    actionLabel: "Open the booking",
  };
}
