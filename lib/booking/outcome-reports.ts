/**
 * What a participant's no-show report does to a negative verdict. A report can
 * speed up or block a verdict; it never creates one. Pure and client-safe.
 */

import type { NegativeMoneyOutcome } from "./misses";
import { SupportFlowReasonEnum, type SupportFlowReason } from "@/schemas/enums";

/** Which side of the session a flow reason is filed from. */
export type ReportSide = "HOST" | "LEARNER";

export type ReportEffect = "dispute" | "agree";

const REASON_SIDE: Partial<Record<SupportFlowReason, ReportSide>> = {
  provider_join_issue: "HOST",
  provider_attended: "HOST",
  attendee_no_show: "HOST",
  provider_no_show: "LEARNER",
  attendee_join_issue: "LEARNER",
  attendee_attended: "LEARNER",
};

/** Per verdict, the reasons from the accused party that dispute it and from the harmed party that agree; any other reason is neutral. */
export const REPORT_EFFECT = {
  HOST_ABSENT: {
    dispute: ["provider_join_issue", "provider_attended"],
    agree: ["provider_no_show"],
  },
  CUT_SHORT: {
    dispute: ["provider_join_issue", "provider_attended"],
    agree: ["provider_no_show"],
  },
  LEARNER_ABSENT: {
    dispute: ["attendee_join_issue", "attendee_attended"],
    agree: [],
  },
} as const satisfies Record<
  NegativeMoneyOutcome,
  {
    dispute: readonly SupportFlowReason[];
    agree: readonly SupportFlowReason[];
  }
>;

/** The reasons that dispute or agree with this verdict. */
export const classifiedReasons = (
  outcome: NegativeMoneyOutcome,
): SupportFlowReason[] => [
  ...REPORT_EFFECT[outcome].dispute,
  ...REPORT_EFFECT[outcome].agree,
];

/** Every reason that disputes or agrees with some negative verdict. */
export const CLASSIFIED_REPORT_REASONS: SupportFlowReason[] = [
  ...new Set(
    Object.values(REPORT_EFFECT).flatMap((e) => [...e.dispute, ...e.agree]),
  ),
];

const isIn = (list: readonly string[], reason: string) => list.includes(reason);

/** The effect a reason would have on this verdict, before any check on who filed it or when. */
export function reportEffect(
  outcome: NegativeMoneyOutcome,
  reason: string | null,
): ReportEffect | null {
  if (!reason) return null;
  if (isIn(REPORT_EFFECT[outcome].dispute, reason)) return "dispute";
  if (isIn(REPORT_EFFECT[outcome].agree, reason)) return "agree";
  return null;
}

export function reasonSide(reason: string | null): ReportSide | null {
  const parsed = SupportFlowReasonEnum.safeParse(reason);
  return parsed.success ? (REASON_SIDE[parsed.data] ?? null) : null;
}

/** A support case linked to the session, in the fields the judgement reads. */
export interface OutcomeReport {
  flowReason: string | null;
  requesterUserId: string;
  ownershipScope: string;
  /** When the reason was answered, which may be long after the case was opened. */
  flowReasonAt: Date | null;
  deletedAt: Date | null;
}

/** The verdict a report is about, with who may report on each side. */
export interface ReportedVerdict {
  outcome: NegativeMoneyOutcome;
  /** The booked end; a reason answered from here counts. */
  endsAt: Date;
  /** `outcomeAt` plus the report window; a reason answered up to here counts. */
  windowClosesAt: Date;
  hostUserIds: readonly string[];
  /** Live learner seat holders of the appointment. */
  learnerUserIds: readonly string[];
}

/** The effect this report has, or null when it is neutral or does not count. */
export function countedEffect(
  report: OutcomeReport,
  verdict: ReportedVerdict,
): ReportEffect | null {
  const effect = reportEffect(verdict.outcome, report.flowReason);
  if (!effect || report.deletedAt) return null;
  // An org operator's case goes to ops with no effect on the verdict.
  if (report.ownershipScope === "ORG_OPERATIONS") return null;
  const answeredAt = report.flowReasonAt;
  if (!answeredAt || answeredAt < verdict.endsAt) return null;
  if (answeredAt > verdict.windowClosesAt) return null;
  const by = report.requesterUserId;
  const isHost = verdict.hostUserIds.includes(by);
  const onSide =
    reasonSide(report.flowReason) === "HOST"
      ? isHost
      : !isHost && verdict.learnerUserIds.includes(by);
  return onSide ? effect : null;
}

/** Any counted dispute wins over an agreement. */
export function judgeReports(
  reports: readonly OutcomeReport[],
  verdict: ReportedVerdict,
): "disputed" | "agreed" | "silent" {
  const effects = reports.map((r) => countedEffect(r, verdict));
  if (effects.includes("dispute")) return "disputed";
  if (effects.includes("agree")) return "agreed";
  return "silent";
}
