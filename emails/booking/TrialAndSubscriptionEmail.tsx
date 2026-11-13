import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type TrialAndSubscriptionEmailKind =
  | "TRIAL_REQUESTED"
  | "TRIAL_COMPLETED"
  | "TRIAL_CANCELLED"
  | "SUBSCRIPTION_STARTED"
  | "SUBSCRIPTION_RENEWED";

export interface TrialAndSubscriptionEmailProps {
  kind: TrialAndSubscriptionEmailKind;
  recipientName?: string;
  recipientRole?: "consultant" | "consultee";
  planTitle: string;
  consultantName?: string;
  consulteeName?: string;
  startsAtText?: string;
  nextBatch?: number;
  remainingSessions?: number;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

export function trialAndSubscriptionSubject(
  args: Pick<
    TrialAndSubscriptionEmailProps,
    "kind" | "planTitle" | "consulteeName" | "consultantName"
  >,
): string {
  switch (args.kind) {
    case "TRIAL_REQUESTED":
      return `New trial request: ${args.consulteeName ?? "A client"} for ${args.planTitle}`;
    case "TRIAL_COMPLETED":
      return `Trial completed: ${args.planTitle}`;
    case "TRIAL_CANCELLED":
      return `Trial cancelled: ${args.planTitle}`;
    case "SUBSCRIPTION_STARTED":
      return `Your subscription to ${args.planTitle} is active`;
    case "SUBSCRIPTION_RENEWED":
      return `Next sessions ready to schedule: ${args.planTitle}`;
  }
}

function renderNextCycleSummary(
  consultantName: string | undefined,
  nextBatch: number,
  remainingSessions: number | undefined,
): string {
  const batchText = nextBatch === 1 ? "session" : `${nextBatch} sessions`;
  const remainingSuffix =
    typeof remainingSessions === "number"
      ? ` (${remainingSessions} remaining)`
      : "";
  return ` — ${consultantName ?? "your consultant"} will schedule your next ${batchText}${remainingSuffix}`;
}

function renderTrialAndSubscriptionBody(args: {
  kind: TrialAndSubscriptionEmailKind;
  recipientName?: string;
  recipientRole?: "consultant" | "consultee";
  planTitle: string;
  consultantName?: string;
  consulteeName?: string;
  startsAtText?: string;
  nextBatch?: number;
  remainingSessions?: number;
}): React.ReactNode {
  const {
    kind,
    recipientName,
    recipientRole,
    planTitle,
    consultantName,
    consulteeName,
    startsAtText,
    nextBatch,
    remainingSessions,
  } = args;

  const isConsultantRecipient =
    recipientRole === "consultant" ||
    (!recipientRole &&
      Boolean(
        recipientName &&
        consultantName &&
        recipientName === consultantName &&
        consulteeName,
      ));

  switch (kind) {
    case "TRIAL_REQUESTED":
      return (
        <Text style={paragraph}>
          <strong>{consulteeName ?? "A client"}</strong> requested a trial
          session for <strong>{planTitle}</strong>
          {startsAtText ? (
            <>
              {" "}
              on <strong>{startsAtText}</strong>
            </>
          ) : null}
          . Open your dashboard to accept or propose another time.
        </Text>
      );
    case "TRIAL_COMPLETED": {
      const otherParty = isConsultantRecipient
        ? consulteeName
        : (consultantName ?? consulteeName);
      return (
        <Text style={paragraph}>
          Your trial session for <strong>{planTitle}</strong>
          {otherParty ? (
            <>
              {" "}
              with <strong>{otherParty}</strong>
            </>
          ) : null}{" "}
          has concluded.{" "}
          {isConsultantRecipient
            ? "Open your dashboard to review session notes or follow up with your client."
            : "Open your dashboard to review notes or continue with a full plan."}
        </Text>
      );
    }
    case "TRIAL_CANCELLED":
      return (
        <Text style={paragraph}>
          The trial session for <strong>{planTitle}</strong>
          {startsAtText ? (
            <>
              {" "}
              scheduled for <strong>{startsAtText}</strong>
            </>
          ) : null}{" "}
          has been cancelled.
        </Text>
      );
    case "SUBSCRIPTION_STARTED":
      return (
        <Text style={paragraph}>
          Your subscription to <strong>{planTitle}</strong>
          {consultantName ? (
            <>
              {" "}
              with <strong>{consultantName}</strong>
            </>
          ) : null}{" "}
          is active. View your scheduled sessions and shared resources from your
          dashboard.
        </Text>
      );
    case "SUBSCRIPTION_RENEWED":
      return (
        <Text style={paragraph}>
          Your latest sessions of <strong>{planTitle}</strong> are complete
          {typeof nextBatch === "number"
            ? renderNextCycleSummary(
                consultantName,
                nextBatch,
                remainingSessions,
              )
            : null}
          .
        </Text>
      );
  }
}

export function TrialAndSubscriptionEmail({
  kind,
  recipientName = "there",
  recipientRole,
  planTitle,
  consultantName,
  consulteeName,
  startsAtText,
  nextBatch,
  remainingSessions,
  dashboardUrl,
  unsubscribeUrl,
}: Readonly<TrialAndSubscriptionEmailProps>) {
  const subject = trialAndSubscriptionSubject({
    kind,
    planTitle,
    consulteeName,
    consultantName,
  });

  const actionLabel =
    kind === "TRIAL_REQUESTED" ? "Review request" : "Open dashboard";

  return (
    <EmailLayout preview={subject} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>

      {renderTrialAndSubscriptionBody({
        kind,
        recipientName,
        recipientRole,
        planTitle,
        consultantName,
        consulteeName,
        startsAtText,
        nextBatch,
        remainingSessions,
      })}

      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          {actionLabel}
        </Button>
      </Section>
    </EmailLayout>
  );
}

export default TrialAndSubscriptionEmail;
