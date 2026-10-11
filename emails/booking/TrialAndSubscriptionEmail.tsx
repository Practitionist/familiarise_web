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
  planTitle: string;
  consultantName?: string;
  consulteeName?: string;
  startsAtText?: string;
  cycleOrdinal?: number;
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

export function TrialAndSubscriptionEmail({
  kind,
  recipientName = "there",
  planTitle,
  consultantName,
  consulteeName,
  startsAtText,
  cycleOrdinal,
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

      {kind === "TRIAL_REQUESTED" ? (
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
      ) : null}

      {kind === "TRIAL_COMPLETED" ? (
        <Text style={paragraph}>
          Your trial session for <strong>{planTitle}</strong>
          {consultantName ? (
            <>
              {" "}
              with <strong>{consultantName}</strong>
            </>
          ) : null}{" "}
          has concluded. Open your dashboard to review notes or continue with a
          full plan.
        </Text>
      ) : null}

      {kind === "TRIAL_CANCELLED" ? (
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
      ) : null}

      {kind === "SUBSCRIPTION_STARTED" ? (
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
      ) : null}

      {kind === "SUBSCRIPTION_RENEWED" ? (
        <Text style={paragraph}>
          {typeof cycleOrdinal === "number"
            ? `Cycle ${cycleOrdinal} of `
            : "Your current cycle of "}
          <strong>{planTitle}</strong> is complete
          {typeof nextBatch === "number" ? (
            <>
              {" "}
              — {consultantName ?? "your consultant"} will schedule your next{" "}
              {nextBatch === 1 ? "session" : `${nextBatch} sessions`}
              {typeof remainingSessions === "number"
                ? ` (${remainingSessions} remaining)`
                : ""}
            </>
          ) : null}
          .
        </Text>
      ) : null}

      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          {actionLabel}
        </Button>
      </Section>
    </EmailLayout>
  );
}

export default TrialAndSubscriptionEmail;
