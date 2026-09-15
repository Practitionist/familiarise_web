import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type RescheduleEmailOutcome =
  | "PROPOSED"
  | "MOVED"
  | "DECLINED"
  | "WITHDRAWN"
  | "RELEASED";

export interface AppointmentRescheduledEmailProps {
  outcome: RescheduleEmailOutcome;
  recipientName: string;
  appointmentType: string;
  /** Pre-formatted in the recipient's zone. */
  oldStartsAtText?: string;
  newStartsAtText?: string;
  proposedBy?: string;
  /** PROPOSED only; when absent the copy says "before it lapses". */
  respondByText?: string;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

// #1653 — PROPOSED is the time-boxed P0; the other four share one short
// informational body, mirroring the in-app branching in lib/novu/templates/b2c.ts.
function informationalBody(props: AppointmentRescheduledEmailProps): string {
  const { outcome, appointmentType, oldStartsAtText, newStartsAtText } = props;
  const stays = oldStartsAtText ? `; it stays on ${oldStartsAtText}` : "";
  switch (outcome) {
    case "MOVED":
      return `Your ${appointmentType} moved from ${oldStartsAtText ?? "its earlier time"} to ${newStartsAtText ?? "a new time"}.`;
    case "RELEASED":
      return `The ${appointmentType}${oldStartsAtText ? ` on ${oldStartsAtText}` : ""} was released. You will be told once a new time is set.`;
    case "DECLINED":
      return `The proposed new time for your ${appointmentType} was declined${stays}.`;
    default:
      return `The reschedule request for your ${appointmentType} was withdrawn${stays}.`;
  }
}

const TITLES: Record<RescheduleEmailOutcome, (t: string) => string> = {
  PROPOSED: (t) => `New time proposed for your ${t}`,
  MOVED: (t) => `Your ${t} has moved`,
  RELEASED: (t) => `Your ${t} time was released`,
  DECLINED: (t) => `Proposed time declined for your ${t}`,
  WITHDRAWN: (t) => `Reschedule request withdrawn for your ${t}`,
};

export default function AppointmentRescheduledEmail(
  props: AppointmentRescheduledEmailProps,
) {
  const {
    outcome,
    recipientName,
    appointmentType,
    oldStartsAtText,
    newStartsAtText,
    proposedBy,
    respondByText,
    dashboardUrl,
    unsubscribeUrl,
  } = props;
  const title = TITLES[outcome](appointmentType);
  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      {outcome === "PROPOSED" ? (
        <>
          <Text style={paragraph}>
            {proposedBy ?? "The other party"} proposed a new time for your{" "}
            {appointmentType}: <strong>{newStartsAtText}</strong> instead of{" "}
            {oldStartsAtText}.
          </Text>
          <Text style={paragraph}>
            Please accept or decline it{" "}
            {respondByText ? (
              <>
                by <strong>{respondByText}</strong>
              </>
            ) : (
              "before it lapses"
            )}
            . If nobody responds in time the proposal lapses and the session
            stays unscheduled until a new time is agreed.
          </Text>
        </>
      ) : (
        <Text style={paragraph}>{informationalBody(props)}</Text>
      )}
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          {outcome === "PROPOSED" ? "Review the new time" : "View booking"}
        </Button>
      </Section>
    </EmailLayout>
  );
}
