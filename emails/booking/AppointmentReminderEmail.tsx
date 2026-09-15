import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface AppointmentReminderEmailProps {
  recipientName: string;
  otherPartyName: string;
  planTitle: string;
  appointmentType: string;
  /** Pre-formatted in the recipient's zone. */
  startsAtText: string;
  /** "tomorrow" for the 24h window, "in about an hour" for the 1h one. */
  windowLabel: string;
  /** Set only when the meeting route is known; switches the CTA to "Join session". */
  joinUrl?: string;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

export default function AppointmentReminderEmail({
  recipientName,
  otherPartyName,
  planTitle,
  appointmentType,
  startsAtText,
  windowLabel,
  joinUrl,
  dashboardUrl,
  unsubscribeUrl,
}: AppointmentReminderEmailProps) {
  return (
    <EmailLayout
      preview={`${startsAtText} with ${otherPartyName}`}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Text style={heading}>Reminder: your {appointmentType} is coming up</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        Your {appointmentType} for <strong>{planTitle}</strong> with{" "}
        {otherPartyName} is {windowLabel}, on <strong>{startsAtText}</strong>.
      </Text>
      <Text style={paragraph}>
        {joinUrl
          ? "The meeting room is open from your dashboard and from the button below."
          : "The join link appears on your dashboard shortly before the session starts."}
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={joinUrl ?? dashboardUrl}>
          {joinUrl ? "Join session" : "View booking"}
        </Button>
      </Section>
    </EmailLayout>
  );
}
