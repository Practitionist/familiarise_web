import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface UnplacedWeeksEmailProps {
  consultantName: string;
  weeks: {
    consulteeName: string;
    planTitle: string;
    number: number;
    count: number;
    sessions: number;
    range: string;
    url: string;
  }[];
  unsubscribeUrl?: string | null;
}

/** The daily plan-week reminder: every plan still owing sessions this week. */
export default function UnplacedWeeksEmail({
  consultantName,
  weeks,
  unsubscribeUrl,
}: UnplacedWeeksEmailProps) {
  const title =
    weeks.length === 1
      ? `${weeks[0].consulteeName}'s week ${weeks[0].number} needs session times`
      : `${weeks.length} plans need session times this week`;
  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {consultantName},</Text>
      <Text style={paragraph}>
        One tap places them in your open hours, or pick the times yourself.
      </Text>
      {weeks.map((week) => (
        <Section key={week.url} style={buttonContainer}>
          <Text style={paragraph}>
            <strong>{week.consulteeName}</strong> · {week.planTitle} · week{" "}
            {week.number} of {week.count} ({week.range}) ·{" "}
            {week.sessions === 1 ? "1 session" : `${week.sessions} sessions`} to
            schedule
          </Text>
          <Button style={button} href={week.url}>
            Auto-schedule this week
          </Button>
        </Section>
      ))}
    </EmailLayout>
  );
}
