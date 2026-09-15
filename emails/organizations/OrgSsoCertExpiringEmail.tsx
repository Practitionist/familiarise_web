import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type SsoCertSeverity = "WARN" | "CRITICAL" | "EXPIRED";

export interface OrgSsoCertExpiringEmailProps {
  orgName: string;
  providerName: string;
  severity: SsoCertSeverity;
  /** Whole days left; ignored once the certificate has expired. */
  daysRemaining?: number;
  /** Pre-formatted in the recipient's zone. */
  expiresAtText: string;
  updateUrl: string;
}

export function orgSsoCertExpiringSubject({
  orgName,
  severity,
  daysRemaining,
}: Pick<
  OrgSsoCertExpiringEmailProps,
  "orgName" | "severity" | "daysRemaining"
>): string {
  if (severity === "EXPIRED") {
    return `SSO certificate for ${orgName} has expired`;
  }
  const days = daysRemaining ?? 0;
  return `SSO certificate for ${orgName} expires in ${days} ${days === 1 ? "day" : "days"}`;
}

// A required notice to the org's owners: single sign-on stops working the
// moment the certificate lapses, so it cannot be turned off (#1653).
export default function OrgSsoCertExpiringEmail({
  orgName,
  providerName,
  severity,
  daysRemaining,
  expiresAtText,
  updateUrl,
}: OrgSsoCertExpiringEmailProps) {
  const subject = orgSsoCertExpiringSubject({
    orgName,
    severity,
    daysRemaining,
  });
  const expired = severity === "EXPIRED";
  return (
    <EmailLayout preview={subject} requiredNotice>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>
        The SAML signing certificate for <strong>{orgName}</strong>&apos;s
        identity provider <strong>{providerName}</strong>{" "}
        {expired ? "expired on" : "expires on"} <strong>{expiresAtText}</strong>
        .
      </Text>
      <Text style={paragraph}>
        {expired
          ? "Members of the organisation can no longer sign in with single sign-on until a new certificate is uploaded."
          : "Once it expires, members of the organisation will not be able to sign in with single sign-on until a new certificate is uploaded."}
      </Text>
      <Text style={paragraph}>
        Download the current signing certificate from your identity provider,
        then paste it into the SSO settings of the organisation dashboard.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={updateUrl}>
          Update certificate
        </Button>
      </Section>
    </EmailLayout>
  );
}
