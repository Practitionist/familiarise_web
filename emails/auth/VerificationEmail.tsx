import {
  Button,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Text,
} from "react-email";
import * as React from "react";
import { getAppUrl } from "@/lib/url";
import { EmailFooter } from "@/emails/components/EmailFooter";
import { EmailLogo } from "@/emails/components/EmailLogo";

interface VerificationEmailProps {
  name: string;
  verificationLink: string;
}

export const VerificationEmail = ({
  name = "Valued User",
  verificationLink = `${getAppUrl()}/api/auth/verify-email?token=123`,
}: VerificationEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>Verify your Familiarise email address</Preview>
      <Section style={main}>
        <Container style={container}>
          <EmailLogo />
          <Section style={content}>
            <Text style={heading}>Confirm your email</Text>
            <Text style={paragraph}>Hi {name},</Text>
            <Text style={paragraph}>
              Thanks for signing up for Familiarise. Please confirm that this is
              your email address by clicking the button below.
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={verificationLink}>
                Verify Email Address
              </Button>
            </Section>
            <Text style={paragraph}>
              This link is valid for the next hour. If you didn't create a
              Familiarise account, you can safely ignore this email.
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
