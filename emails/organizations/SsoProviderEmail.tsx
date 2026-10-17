import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type SsoProviderEmailKind =
  "SUBMITTED" | "APPROVED" | "REJECTED" | "REVOKED" | "DELETED";

export interface SsoProviderEmailProps {
  kind: SsoProviderEmailKind;
  recipientName: string;
  orgName: string;
  providerId: string;
  domains?: string[];
  issuer?: string;
  deletedByName?: string;
  reason?: string;
  actionUrl: string;
}

export function ssoProviderSubject(
  kind: SsoProviderEmailKind,
  orgName: string,
): string {
  switch (kind) {
    case "SUBMITTED":
      return `SSO provider awaiting approval: ${orgName}`;
    case "APPROVED":
      return `Your SSO provider is approved for ${orgName}`;
    case "REJECTED":
      return `Your SSO provider was not approved for ${orgName}`;
    case "REVOKED":
      return `Your SSO provider was revoked for ${orgName}`;
    case "DELETED":
      return `SSO provider removed from ${orgName}`;
  }
}

function bodyText(props: SsoProviderEmailProps): string {
  const domains = props.domains?.join(", ") || "your workspace domains";
  const issuer = props.issuer || props.providerId;
  switch (props.kind) {
    case "SUBMITTED":
      return `${props.orgName} registered the OIDC provider ${props.providerId} (${issuer}) for ${domains}. It cannot be used until an admin approves it.`;
    case "APPROVED":
      return `People at ${domains} can now sign in through ${issuer}. Sign in once through it as an owner before you turn on SSO enforcement.`;
    case "REJECTED":
      return `Your OIDC provider ${props.providerId} (${issuer}) for ${domains} was not approved. Members continue signing in with their existing methods.`;
    case "REVOKED":
      return `Sign-in through ${issuer} for ${domains} was revoked and has stopped. Members can use their other sign-in methods unless SSO is enforced.`;
    case "DELETED": {
      const actorPrefix = props.deletedByName
        ? `${props.deletedByName} removed `
        : "The ";
      return `${actorPrefix}SSO provider ${props.providerId} from ${props.orgName}. Workspace members now sign in with email.`;
    }
  }
}

// Required notice: an IAM change to the organisation, not marketing.
export default function SsoProviderEmail(props: SsoProviderEmailProps) {
  const subject = ssoProviderSubject(props.kind, props.orgName);
  return (
    <EmailLayout preview={subject} requiredNotice>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {props.recipientName},</Text>
      <Text style={paragraph}>{bodyText(props)}</Text>
      {props.reason && (
        <Text style={paragraph}>
          Reason given: <em>{props.reason}</em>
        </Text>
      )}
      <Section style={buttonContainer}>
        <Button style={button} href={props.actionUrl}>
          {props.kind === "SUBMITTED" ? "Review provider" : "Open SSO settings"}
        </Button>
      </Section>
    </EmailLayout>
  );
}
