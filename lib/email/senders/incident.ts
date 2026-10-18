import * as React from "react";
import type { IncidentRemedyKind } from "@prisma/client";

import {
  PLATFORM_INCIDENT_SUBJECT,
  PlatformIncidentEmail,
} from "@/emails/booking/PlatformIncidentEmail";
import { goHref } from "@/lib/dashboard/go";
import { SENDERS } from "../config";
import type { EmailRecipient } from "../preferences";
import {
  absolute,
  dateText,
  greet,
  stageSpecGuarded,
  whenText,
  type StagingTx,
} from "./shared";

export const PLATFORM_INCIDENT_DIGEST = "PLATFORM_INCIDENT_DIGEST";

export interface IncidentDigestItem {
  kind: IncidentRemedyKind;
  appointmentId: string;
  planTitle: string;
  expertName: string | null;
  startsAt: Date;
  dueAt: Date;
  /** A subscription's plan end, when the plan is still live. */
  planEndsAt: Date | null;
  /** The free session a 1:1 was already rebooked to. */
  rebookedStartsAt: Date | null;
  /** The booking can still take a free rebook. */
  rebookable: boolean;
}

interface IncidentDigestArgs {
  incidentId: string;
  userId: string;
  items: IncidentDigestItem[];
}

/** One sentence per remedy kind, in the reader's zone. */
export function incidentRemedyText(
  item: IncidentDigestItem,
  zone: string,
): string {
  switch (item.kind) {
    case "REFUND_AT_DUE":
      if (item.rebookedStartsAt) {
        return `You rebooked this session free for ${whenText(item.rebookedStartsAt, zone)}.`;
      }
      return !item.rebookable
        ? `You get a full refund on ${dateText(item.dueAt, zone)}.`
        : `Rebook free with ${item.expertName ?? "your expert"} by ${whenText(item.dueAt, zone)}, or we refund 100 % on ${dateText(item.dueAt, zone)}.`;
    case "REFUND_NOW":
      return "You get a full refund now.";
    case "TRIAL_REOFFER":
      return "This trial did not count, so you can request a new trial with the same expert.";
    case "SUBSCRIPTION_EXTEND":
      return item.planEndsAt
        ? `This session is back in your plan, which now runs until ${dateText(item.planEndsAt, zone)}.`
        : "This session is back in your plan; if your plan has ended, it is refunded at the per-session price.";
    case "CLASS_EXISTING":
      return "This session did not count. Your host has 14 days to schedule a make-up; if they do not, you get that session refunded.";
  }
}

/** Stages the learner's digest on the caller's transaction, beside the notifiedAt stamp. */
export function stagePlatformIncidentDigest(
  tx: StagingTx,
  args: IncidentDigestArgs,
) {
  const dashboardUrl = absolute(goHref("client", "appointments"));
  return stageSpecGuarded(
    {
      emailType: PLATFORM_INCIDENT_DIGEST,
      // A money notice about the learner's own sessions: never opted out of.
      category: null,
      from: SENDERS.notifications,
      entityRef: `incident:${args.incidentId}:user:${args.userId}`,
      subject: () => PLATFORM_INCIDENT_SUBJECT,
      render: (r: EmailRecipient) =>
        React.createElement(PlatformIncidentEmail, {
          recipientName: greet(r),
          dashboardUrl,
          items: args.items.map((item) => ({
            planTitle: item.planTitle,
            startsAtText: whenText(item.startsAt, r.zone),
            remedyText: incidentRemedyText(item, r.zone),
            rebookUrl:
              item.kind === "REFUND_AT_DUE" &&
              item.rebookable &&
              !item.rebookedStartsAt
                ? absolute(
                    goHref("client", `appointments/${item.appointmentId}`),
                  )
                : undefined,
          })),
        }),
    },
    [args.userId],
    tx,
  );
}
