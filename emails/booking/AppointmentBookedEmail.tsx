import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface AppointmentBookedEmailProps {
  role: "consultee" | "consultant";
  recipientName: string;
  otherPartyName: string;
  planTitle: string;
  appointmentType: string;
  /** Pre-formatted in the recipient's zone, zone label included. */
  startsAtText: string;
  dashboardUrl: string;
  cancellationWindowText?: string;
  unsubscribeUrl?: string | null;
}

// #1653 — one payload reaches both parties, so the copy switches on `role`:
// the consultee hears "confirmed", the consultant hears "new booking".
export default function AppointmentBookedEmail({
  role,
  recipientName,
  otherPartyName,
  planTitle,
  appointmentType,
  startsAtText,
  dashboardUrl,
  cancellationWindowText,
  unsubscribeUrl,
}: AppointmentBookedEmailProps) {
  const title =
    role === "consultee"
      ? `Your ${appointmentType} with ${otherPartyName} is confirmed`
      : `New booking: ${otherPartyName} for ${planTitle}`;
  return (
    <EmailLayout
      preview={`${planTitle} — ${startsAtText}`}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        {role === "consultee" ? (
          <>
            Your {appointmentType} for <strong>{planTitle}</strong> with{" "}
            {otherPartyName} is booked for <strong>{startsAtText}</strong>.
          </>
        ) : (
          <>
            {otherPartyName} booked your {appointmentType}{" "}
            <strong>{planTitle}</strong> for <strong>{startsAtText}</strong>.
          </>
        )}
      </Text>
      <Text style={paragraph}>
        A meeting room is created for this session and the join link appears on
        your dashboard on the day.
      </Text>
      <Text style={paragraph}>
        {cancellationWindowText
          ? `Need to change plans? You can reschedule or cancel from your dashboard ${cancellationWindowText}.`
          : "Need to change plans? You can reschedule or cancel from your dashboard; the plan's cancellation policy applies."}
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          View booking
        </Button>
      </Section>
    </EmailLayout>
  );
}
