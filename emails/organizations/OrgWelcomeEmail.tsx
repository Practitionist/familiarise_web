import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";
import { memberRoleLabel } from "./OrgMembershipChangedEmail";

export interface OrgWelcomeEmailProps {
  recipientName?: string;
  orgName: string;
  role: string;
  dashboardUrl: string;
}

export function orgWelcomeSubject(orgName: string): string {
  return `Welcome to ${orgName} on Familiarise`;
}

// Required notice to the joiner: confirms the invite-accept landed and
// where to go next.
export default function OrgWelcomeEmail({
  recipientName = "there",
  orgName,
  role,
  dashboardUrl,
}: OrgWelcomeEmailProps) {
  const subject = orgWelcomeSubject(orgName);
  return (
    <EmailLayout preview={subject} requiredNotice>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        You have joined <strong>{orgName}</strong> as a{" "}
        <strong>{memberRoleLabel(role)}</strong>. You can now see its dashboard,
        programmes, and bookings.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          Open organisation dashboard
        </Button>
      </Section>
    </EmailLayout>
  );
}
