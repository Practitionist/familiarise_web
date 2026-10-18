import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface PlatformIncidentEmailItem {
  planTitle: string;
  startsAtText: string;
  /** What happens to this session, in one sentence. */
  remedyText: string;
}

export interface PlatformIncidentEmailProps {
  recipientName?: string;
  items: PlatformIncidentEmailItem[];
  dashboardUrl: string;
}

export const PLATFORM_INCIDENT_SUBJECT =
  "We had a platform problem, and your sessions are covered";

/** One digest per learner per declared incident: every affected session and its remedy. */
export function PlatformIncidentEmail({
  recipientName = "there",
  items,
  dashboardUrl,
}: Readonly<PlatformIncidentEmailProps>) {
  return (
    <EmailLayout preview={PLATFORM_INCIDENT_SUBJECT} requiredNotice>
      <Text style={heading}>{PLATFORM_INCIDENT_SUBJECT}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        Familiarise had an outage that affected{" "}
        {items.length === 1 ? "one of your sessions" : "some of your sessions"}.
        It was our fault, not your expert&apos;s and not yours, so none of these
        sessions counts against you. Here is what happens to each one.
      </Text>
      {items.map((item) => (
        <Text key={`${item.planTitle}-${item.startsAtText}`} style={paragraph}>
          <strong>{item.planTitle}</strong>, {item.startsAtText}:{" "}
          {item.remedyText}
        </Text>
      ))}
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          Open your dashboard
        </Button>
      </Section>
    </EmailLayout>
  );
}

export default PlatformIncidentEmail;
