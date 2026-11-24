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
    case "MISSED_RECORDING":
      return `Recording ready from your session: ${args.planTitle}`;
    case "COMPLETED":
      return `Session completed: ${args.planTitle}`;
  }
}

const ACTION_LABEL_BY_KIND: Record<ClassSessionEmailKind, string> = {
  CANCELLED: "Open dashboard",
  MAKEUP_SCHEDULED: "Open dashboard",
  SESSION_REFUNDED: "Open dashboard",
  EXIT_AVAILABLE: "Open dashboard",
  MISSED_RECORDING: "Watch recording",
  COMPLETED: "Rate session",
};

function resolveClassSessionActionHref(
  kind: ClassSessionEmailKind,
  dashboardUrl: string,
  recordingUrl?: string | null,
): string {
  if (kind === "MISSED_RECORDING" && recordingUrl) return recordingUrl;
  return dashboardUrl;
}

function renderClassSessionBody(args: {
  kind: ClassSessionEmailKind;
  planTitle: string;
  consultantName?: string;
  appointmentType: string;
  startsAtText?: string;
  makeUpByText?: string;
  amountText?: string;
  missedCount: number;
  voided: boolean;
}): React.ReactNode {
  const {
    kind,
    planTitle,
    consultantName,
    appointmentType,
    startsAtText,
    makeUpByText,
    amountText,
    missedCount,
    voided,
  } = args;
  const sessionPrefix = startsAtText ? `${startsAtText} ` : "";

  switch (kind) {
    case "CANCELLED":
      return (
        <Text style={paragraph}>
          {voided ? (
            <>
              Your {sessionPrefix}session of <strong>{planTitle}</strong> did
              not run long enough to count as held.
            </>
          ) : (
            <>
              Your {sessionPrefix}session of <strong>{planTitle}</strong> was
              cancelled.
            </>
          )}{" "}
          {consultantName ?? "Your host"} has
          {makeUpByText ? ` until ${makeUpByText}` : " 14 days"} to schedule a
          make-up session, or that session is refunded automatically.
        </Text>
      );
    case "MAKEUP_SCHEDULED":
      return (
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
      );
    case "SESSION_REFUNDED":
      return (
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
      );
    case "EXIT_AVAILABLE":
      return (
        <Text style={paragraph}>
          <strong>{planTitle}</strong> has had {missedCount} missed session
          {missedCount === 1 ? "" : "s"}. You may exit the remaining series from
          your dashboard for a full refund of upcoming sessions.
        </Text>
      );
    case "MISSED_RECORDING":
      return (
        <Text style={paragraph}>
          Sorry we missed you in the {sessionPrefix}session of{" "}
          <strong>{planTitle}</strong>. The session recording is ready for you
          to watch.
        </Text>
      );
    case "COMPLETED":
      return (
        <Text style={paragraph}>
          Your {appointmentType} for <strong>{planTitle}</strong> has ended.
          Open your dashboard to leave feedback or review shared materials.
        </Text>
      );
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
  dashboardUrl,
  unsubscribeUrl,
}: Readonly<ClassSessionEmailProps>) {
  const subject = classSessionSubject({
    kind,
    planTitle,
    voided,
    appointmentType,
  });

  const actionHref = resolveClassSessionActionHref(
    kind,
    dashboardUrl,
    recordingUrl,
  );
  const actionLabel = ACTION_LABEL_BY_KIND[kind];

  return (
    <EmailLayout preview={subject} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>

      {renderClassSessionBody({
        kind,
        planTitle,
        consultantName,
        appointmentType,
        startsAtText,
        makeUpByText,
        amountText,
        missedCount,
        voided,
      })}

      <Section style={buttonContainer}>
        <Button style={button} href={actionHref}>
          {actionLabel}
        </Button>
      </Section>
    </EmailLayout>
  );
}

export default ClassSessionEmail;
