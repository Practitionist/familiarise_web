import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type ClassSessionEmailKind =
  | "CANCELLED"
  | "MAKEUP_SCHEDULED"
  | "SESSION_REFUNDED"
  | "EXIT_AVAILABLE"
  | "NO_SHOW"
  | "MISSED_RECORDING"
  | "COMPLETED";

export interface ClassSessionEmailProps {
  kind: ClassSessionEmailKind;
  recipientName?: string;
  planTitle: string;
  consultantName?: string;
  appointmentType?: string;
  startsAtText?: string;
  makeUpByText?: string;
  amountText?: string;
  missedCount?: number;
  voided?: boolean;
  recordingUrl?: string | null;
  supportUrl?: string | null;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

export function classSessionSubject(
  args: Pick<
    ClassSessionEmailProps,
    "kind" | "planTitle" | "voided" | "appointmentType"
  >,
): string {
  switch (args.kind) {
    case "CANCELLED":
      return args.voided
        ? `Session did not count: ${args.planTitle}`
        : `Session cancelled: ${args.planTitle}`;
    case "MAKEUP_SCHEDULED":
      return `Make-up session scheduled: ${args.planTitle}`;
    case "SESSION_REFUNDED":
      return `Session refund processed: ${args.planTitle}`;
    case "EXIT_AVAILABLE":
      return `Full exit refund option available: ${args.planTitle}`;
    case "NO_SHOW":
      return `We missed you in your session: ${args.planTitle}`;
    case "MISSED_RECORDING":
      return `Recording ready from your session: ${args.planTitle}`;
    case "COMPLETED":
      return `Session completed: ${args.planTitle}`;
  }
}

export function ClassSessionEmail({
  kind,
  recipientName = "there",
  planTitle,
  consultantName,
  appointmentType = "session",
  startsAtText,
  makeUpByText,
  amountText,
  missedCount = 1,
  voided = false,
  recordingUrl,
  supportUrl,
  dashboardUrl,
  unsubscribeUrl,
}: Readonly<ClassSessionEmailProps>) {
  const subject = classSessionSubject({
    kind,
    planTitle,
    voided,
    appointmentType,
  });

  const actionHref =
    kind === "MISSED_RECORDING" && recordingUrl
      ? recordingUrl
      : kind === "NO_SHOW" && supportUrl
        ? supportUrl
        : dashboardUrl;

  const actionLabel =
    kind === "MISSED_RECORDING"
      ? "Watch recording"
      : kind === "NO_SHOW"
        ? "Contact support"
        : kind === "COMPLETED"
          ? "Rate session"
          : "Open dashboard";

  return (
    <EmailLayout preview={subject} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>

      {kind === "CANCELLED" ? (
        <Text style={paragraph}>
          {voided ? (
            <>
              Your {startsAtText ? `${startsAtText} ` : ""}session of{" "}
              <strong>{planTitle}</strong> did not run long enough to count as
              held.
            </>
          ) : (
            <>
              Your {startsAtText ? `${startsAtText} ` : ""}session of{" "}
              <strong>{planTitle}</strong> was cancelled.
            </>
          )}{" "}
          {consultantName ?? "Your host"} has
          {makeUpByText ? ` until ${makeUpByText}` : " 14 days"} to schedule a
          make-up session, or that session is refunded automatically.
        </Text>
      ) : null}

      {kind === "MAKEUP_SCHEDULED" ? (
        <Text style={paragraph}>
          A make-up session for <strong>{planTitle}</strong> has been scheduled
          {startsAtText ? (
            <>
              {" "}
              on <strong>{startsAtText}</strong>
            </>
          ) : null}
          .
        </Text>
      ) : null}

      {kind === "SESSION_REFUNDED" ? (
        <Text style={paragraph}>
          A missed session of <strong>{planTitle}</strong> was not made up in
          time
          {amountText ? (
            <>
              , so <strong>{amountText}</strong> is on its way back to you
            </>
          ) : null}
          .
        </Text>
      ) : null}

      {kind === "EXIT_AVAILABLE" ? (
        <Text style={paragraph}>
          <strong>{planTitle}</strong> has had {missedCount} missed session
          {missedCount === 1 ? "" : "s"}. You may exit the remaining series from
          your dashboard for a full refund of upcoming sessions.
        </Text>
      ) : null}

      {kind === "NO_SHOW" ? (
        <Text style={paragraph}>
          Your {startsAtText ? `${startsAtText} ` : ""}session of{" "}
          <strong>{planTitle}</strong> went ahead without you and counts as
          held. If you were unable to connect, reach out to support so we can
          review the call record.
          {recordingUrl ? " A recording is available in your dashboard." : ""}
        </Text>
      ) : null}

      {kind === "MISSED_RECORDING" ? (
        <Text style={paragraph}>
          Sorry we missed you in the {startsAtText ? `${startsAtText} ` : ""}
          session of <strong>{planTitle}</strong>. The session recording is
          ready for you to watch.
        </Text>
      ) : null}

      {kind === "COMPLETED" ? (
        <Text style={paragraph}>
          Your {appointmentType} for <strong>{planTitle}</strong> has ended.
          Open your dashboard to leave feedback or review shared materials.
        </Text>
      ) : null}

      <Section style={buttonContainer}>
        <Button style={button} href={actionHref}>
          {actionLabel}
        </Button>
      </Section>
    </EmailLayout>
  );
}

export default ClassSessionEmail;
