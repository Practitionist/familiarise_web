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

interface ExistingAccountEmailProps {
  signInUrl: string;
  resetUrl: string;
}

// Sent instead of a verification code when someone signs up with an address
// that already has an account, so the sign-up response cannot reveal which.
export const ExistingAccountEmail = ({
  signInUrl = `${getAppUrl()}/auth/signin`,
  resetUrl = `${getAppUrl()}/auth/forgot-password`,
}: ExistingAccountEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>Someone tried to sign up with your email address</Preview>
      <Section style={main}>
        <Container style={container}>
          <EmailLogo />
          <Section style={content}>
            <Text style={heading}>You already have an account</Text>
            <Text style={paragraph}>Hi there,</Text>
            <Text style={paragraph}>
              Someone just tried to create a Familiarise account with this email
              address, but it already has one. If that was you, sign in instead.
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={signInUrl}>
                Sign in
              </Button>
            </Section>
            <Text style={paragraph}>
              Forgot your password, or never finished setting the account up?{" "}
              <Link href={resetUrl} style={link}>
                Reset your password
              </Link>{" "}
              to take control of it.
            </Text>
            <Text style={paragraph}>
              If it wasn&apos;t you, you can ignore this email; nothing about
              your account has changed.
            </Text>
            <Text style={paragraph}>
              Security regards,
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

const link = {
  color: "#666",
  textDecoration: "underline",
};
