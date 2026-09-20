import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface OrgCreatedEmailProps {
  recipientName?: string;
  orgName: string;
  dashboardUrl: string;
}

export function orgCreatedSubject(orgName: string): string {
  return `Your organisation ${orgName} is created — what happens next`;
}

// Required notice to the creator: the org sits in PENDING_VERIFICATION and
// the next steps unblock billing and invites.
export default function OrgCreatedEmail({
  recipientName = "there",
  orgName,
  dashboardUrl,
}: OrgCreatedEmailProps) {
  const subject = orgCreatedSubject(orgName);
  return (
    <EmailLayout preview={subject} requiredNotice>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        Your organisation <strong>{orgName}</strong> is created. It is now{" "}
        <strong>pending verification</strong>: a platform admin reviews new
        organisations before billing and full member limits unlock. You can
        already invite a small founding team in the meantime.
      </Text>
      <Text style={paragraph}>What happens next:</Text>
      <Text style={paragraph}>
        1. Verification — we review your organisation details.
        <br />
        2. Billing — confirm how the organisation pays for sessions.
        <br />
        3. Invite — bring your team in from the members page.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          Open organisation dashboard
        </Button>
      </Section>
    </EmailLayout>
  );
}
