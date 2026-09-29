import {
  Button,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "react-email";
import * as React from "react";
import type { UserRole } from "@prisma/client";

import { getAppUrl } from "@/lib/url";
import { EmailFooter } from "@/emails/components/EmailFooter";
import { EmailLogo } from "@/emails/components/EmailLogo";

interface StaffInvitationEmailProps {
  /** The admin who minted the invite, or the bootstrap script's label. */
  inviterName: string;
  role: UserRole;
  /** Carries the single-use token. Everything else on this page is cosmetic. */
  inviteUrl: string;
  /** ISO string — the template does its own locale formatting. */
  expiresAt: string;
}

/**
 * #1927 — the mail that hands a platform operator their account.
 *
 * Two things this template must get right, and both are load-bearing:
 *
 *  - It says the address is not a policy. Staff receive mail at a mix of
 *    personal and company addresses, and an earlier draft of this copy
 *    implied "@familiarisenow.com only". That sentence is a lie we would then
 *    have to enforce, and the enforcement would break people.
 *  - It says TWO-FACTOR is required, before they set a password, not after
 *    they hit a 428 on their first console page. The requirement is enforced
 *    in `lib/auth-helpers.ts`; copy that arrives late reads as a bug.
 */
export const StaffInvitationEmail = ({
  inviterName = "A Familiarise administrator",
  role = "STAFF",
  inviteUrl = getAppUrl(),
  expiresAt,
}: StaffInvitationEmailProps) => {
  const isAdmin = role === "ADMIN";
  const roleLabel = isAdmin ? "administrator" : "staff member";
  const expiryText = expiresAt
    ? `This link expires on ${new Date(expiresAt).toLocaleDateString("en-IN", {
        dateStyle: "long",
      })} (72 hours after it was sent).`
    : "This link expires 72 hours after it was sent.";

  return (
    <Html>
      <Head />
      <Preview>
        {inviterName} invited you to join Familiarise as a {roleLabel}
      </Preview>
      <Section style={main}>
        <Container style={container}>
          <EmailLogo />
          <Section style={content}>
            <Text style={heading}>You&apos;re invited to join Familiarise</Text>
            <Text style={paragraph}>
              {inviterName} has invited you to work on Familiarise as a{" "}
              <strong>{roleLabel}</strong>. You&apos;ll choose your own password
              on the next screen — we never set one for you.
            </Text>

            <Section style={buttonContainer}>
              <Button style={button} href={inviteUrl}>
                Set your password
              </Button>
            </Section>

            <Text style={smallText}>{expiryText}</Text>

            <Hr style={hr} />

            <Text style={paragraph}>
              <strong>Two things to know before you start.</strong>
            </Text>
            <Text style={listItem}>
              <strong>Two-factor authentication is required.</strong> Your
              account will ask for it the first time you open the console. Set
              it up straight away — it is a five-minute job with an
              authenticator app.
            </Text>
            <Text style={listItem}>
              <strong>
                Your email address is not tied to a company domain.
              </strong>{" "}
              Use whichever address you were invited on, personal or work. We
              will never silently move your access to a different one, and
              losing access is something an administrator does on purpose and
              you will be told about.
            </Text>

            <Text style={paragraph}>
              If you were not expecting this invitation, ignore this email and
              nothing happens — the link expires on its own.
            </Text>
            <Text style={paragraph}>
              Best regards,
              <br />
              The Familiarise Team
            </Text>
          </Section>
          <EmailFooter showSupport />
        </Container>
      </Section>
    </Html>
  );
};

const main = {
  backgroundColor: "#f5f5f5",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif',
};
const container = { margin: "0 auto", padding: "20px 0", maxWidth: "600px" };
const content = {
  backgroundColor: "#ffffff",
  padding: "30px",
  borderRadius: "5px",
};
const heading = {
  fontSize: "24px",
  fontWeight: "bold" as const,
  color: "#333",
  lineHeight: "1.3",
  margin: "0 0 20px",
};
const paragraph = {
  fontSize: "16px",
  lineHeight: "1.5",
  color: "#444",
  margin: "0 0 20px",
};
const listItem = {
  fontSize: "15px",
  lineHeight: "1.5",
  color: "#444",
  margin: "0 0 12px",
};
const smallText = {
  fontSize: "13px",
  lineHeight: "1.5",
  color: "#888",
  margin: "0 0 20px",
};
const hr = {
  borderColor: "#e5e5e5",
  margin: "24px 0",
};
const buttonContainer = { textAlign: "center" as const, margin: "30px 0" };
const button = {
  backgroundColor: "#000000",
  borderRadius: "5px",
  color: "#fff",
  fontSize: "16px",
  fontWeight: "normal" as const,
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  padding: "12px 20px",
};
