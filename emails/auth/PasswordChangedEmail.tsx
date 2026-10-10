import {
  Button,
  Container,
  Head,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "react-email";
import * as React from "react";
import { getAppUrl } from "@/lib/url";
import { EmailFooter } from "@/emails/components/EmailFooter";
import { EmailLogo } from "@/emails/components/EmailLogo";
import { supportEmail } from "@/lib/email/config";

interface PasswordChangedEmailProps {
  name: string;
  resetUrl: string;
}

export const PasswordChangedEmail = ({
  name = "there",
  resetUrl = `${getAppUrl()}/auth/forgot-password`,
}: PasswordChangedEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>Your Familiarise password was changed</Preview>
      <Section style={main}>
        <Container style={container}>
          <EmailLogo />
          <Section style={content}>
            <Text style={heading}>Your password was changed</Text>
            <Text style={paragraph}>Hi {name},</Text>
            <Text style={paragraph}>
              The password for your Familiarise account was just changed. If
              that was you, there&apos;s nothing else to do.
            </Text>
            <Text style={paragraph}>
              If it wasn&apos;t you, reset your password now; that signs every
              device out of your account.
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={resetUrl}>
                Reset password
              </Button>
            </Section>
            <Text style={paragraph}>
              Need help? Contact{" "}
              <Link href={`mailto:${supportEmail()}`} style={link}>
                {supportEmail()}
              </Link>
              .
            </Text>
            <Text style={paragraph}>
              Security regards,
              <br />
              The Familiarise Team
            </Text>
          </Section>
          <EmailFooter />
        </Container>
      </Section>
    </Html>
  );
};

// Styles
const main = {
  backgroundColor: "#f5f5f5",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif',
};

const container = {
  margin: "0 auto",
  padding: "20px 0",
  maxWidth: "600px",
};

const content = {
  backgroundColor: "#ffffff",
  padding: "30px",
  borderRadius: "5px",
};

const heading = {
  fontSize: "28px",
  fontWeight: "bold",
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

const buttonContainer = {
  textAlign: "center" as const,
  margin: "30px 0",
};

const button = {
  backgroundColor: "#000000",
  borderRadius: "5px",
  color: "#fff",
  fontSize: "16px",
  fontWeight: "normal",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  padding: "12px 20px",
};

const link = {
  color: "#666",
  textDecoration: "underline",
};
