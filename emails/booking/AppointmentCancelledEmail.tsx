import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface AppointmentCancelledEmailProps {
  recipientName: string;
  /** Pre-formatted in the recipient's zone; absent when the booking held no time yet. */
  startsAtText?: string;
  /** Who cancelled, as a name or a role ("The consultant", "Familiarise"). */
  cancelledBy: string;
  reason?: string;
  /** For the payer only, e.g. "A refund of ₹1,200 is on its way". */
  refundText?: string;
  /** A host removed this one seat; the event itself goes ahead. */
  removedFrom?: { eventLabel: string; planTitle: string };
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

export default function AppointmentCancelledEmail({
  recipientName,
  startsAtText,
  cancelledBy,
  reason,
  refundText,
  removedFrom,
  dashboardUrl,
  unsubscribeUrl,
}: AppointmentCancelledEmailProps) {
  if (removedFrom) {
    const removedTitle = `You were removed from ${removedFrom.planTitle}`;
    return (
      <EmailLayout preview={removedTitle} unsubscribeUrl={unsubscribeUrl}>
        <Text style={heading}>{removedTitle}</Text>
        <Text style={paragraph}>Hi {recipientName},</Text>
        <Text style={paragraph}>
          {cancelledBy} removed you from the {removedFrom.eventLabel}{" "}
          <strong>{removedFrom.planTitle}</strong>, so you no longer have a seat
          in it.
        </Text>
        {reason && (
          <Text style={paragraph}>
            Reason given: <em>{reason}</em>
          </Text>
        )}
        {refundText && <Text style={paragraph}>{refundText}</Text>}
        <Section style={buttonContainer}>
          <Button style={button} href={dashboardUrl}>
            View details
          </Button>
        </Section>
      </EmailLayout>
    );
  }
  const title = startsAtText
    ? `Your session on ${startsAtText} was cancelled`
    : "Your session was cancelled";
  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        {cancelledBy} cancelled
        {startsAtText ? (
          <>
            {" "}
            the session scheduled for <strong>{startsAtText}</strong>.
          </>
        ) : (
          " this session."
        )}
      </Text>
      {reason && (
        <Text style={paragraph}>
          Reason given: <em>{reason}</em>
        </Text>
      )}
      {refundText && <Text style={paragraph}>{refundText}</Text>}
      <Text style={paragraph}>
        You can book another time from your dashboard whenever you are ready.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          View details
        </Button>
      </Section>
    </EmailLayout>
  );
}
