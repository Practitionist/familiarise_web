import * as React from "react";
import { Button, Link, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  link,
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
  /** The attendee's own add-to-calendar links; absent for the host. */
  calendar?: { googleUrl: string; icsUrl: string } | null;
  /** Several times placed at once: the attendee's copy lists each with its own calendar link. */
  sessions?: { startsAtText: string; googleUrl: string | null }[];
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
  calendar,
  sessions,
  unsubscribeUrl,
}: AppointmentBookedEmailProps) {
  const listed = role === "consultee" && sessions ? sessions : null;
  const title = listed
    ? `Your sessions with ${otherPartyName} are scheduled`
    : role === "consultee"
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
        {listed ? (
          <>
            Your sessions for <strong>{planTitle}</strong> with {otherPartyName}{" "}
            now have their times:
          </>
        ) : role === "consultee" ? (
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
      {listed?.map((session) => (
        <Text key={session.startsAtText} style={paragraph}>
          <strong>{session.startsAtText}</strong>
          {session.googleUrl ? (
            <>
              {" · "}
              <Link href={session.googleUrl} style={link}>
                Add to Google Calendar
              </Link>
            </>
          ) : null}
        </Text>
      ))}
      <Text style={paragraph}>
        {listed
          ? "A meeting room is created for each session and its join link appears on your dashboard on the day."
          : "A meeting room is created for this session and the join link appears on your dashboard on the day."}
      </Text>
      <Text style={paragraph}>
        {cancellationWindowText
          ? `Need to change plans? You can reschedule or cancel from your dashboard ${cancellationWindowText}.`
          : "Need to change plans? You can reschedule or cancel from your dashboard; the plan's cancellation policy applies."}
      </Text>
      {calendar && listed ? (
        <Text style={paragraph}>
          Add all of them to Apple, Outlook and other calendars:{" "}
          <Link href={calendar.icsUrl} style={link}>
            download the .ics file
          </Link>
          .
        </Text>
      ) : calendar ? (
        <Text style={paragraph}>
          Add it to your calendar:{" "}
          <Link href={calendar.googleUrl} style={link}>
            Google Calendar
          </Link>{" "}
          or{" "}
          <Link href={calendar.icsUrl} style={link}>
            Apple, Outlook and others (.ics)
          </Link>
          .
        </Text>
      ) : null}
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          View booking
        </Button>
      </Section>
    </EmailLayout>
  );
}
