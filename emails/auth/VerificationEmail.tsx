import { Container, Head, Html, Preview, Section, Text } from "react-email";
import * as React from "react";
import { EmailFooter } from "@/emails/components/EmailFooter";
import { EmailLogo } from "@/emails/components/EmailLogo";

interface VerificationEmailProps {
  code: string;
  expiresInMinutes: number;
}

// Sent before the address is proven, so it greets nobody by name: the name is
// whatever the sign-up form was given.
export const VerificationEmail = ({
  code = "123456",
  expiresInMinutes = 10,
}: VerificationEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>{`Your Familiarise verification code is ${code}`}</Preview>
      <Section style={main}>
        <Container style={container}>
          <EmailLogo />
          <Section style={content}>
            <Text style={heading}>Confirm your email</Text>
            <Text style={paragraph}>Hi there,</Text>
            <Text style={paragraph}>
              Enter this code on the Familiarise sign-up page to confirm your
              email address:
            </Text>
            <Text style={codeStyle}>{code}</Text>
            <Text style={paragraph}>
              The code expires in {expiresInMinutes} minutes. Never share it
              with anyone; Familiarise will never ask you for it.
            </Text>
            <Text style={paragraph}>
              If you didn&apos;t try to create a Familiarise account, ignore
              this email and nothing will happen.
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

const codeStyle = {
  fontSize: "32px",
  fontWeight: "bold",
  letterSpacing: "8px",
  color: "#000",
  textAlign: "center" as const,
  margin: "30px 0",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};
