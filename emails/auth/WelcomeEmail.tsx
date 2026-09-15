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

interface WelcomeEmailProps {
  name: string;
  dashboardUrl?: string;
}

export const WelcomeEmail = ({
  name = "Valued User",
  dashboardUrl = `${getAppUrl()}/dashboard`,
}: WelcomeEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>Welcome to Familiarise - Your Expert Connection</Preview>
      <Section style={main}>
        <Container style={container}>
          <EmailLogo />
          <Section style={content}>
            <Text style={heading}>Welcome to Familiarise!</Text>
            <Text style={paragraph}>Hi {name},</Text>
            <Text style={paragraph}>
              Thank you for joining Familiarise! We're thrilled to have you as
              part of our community where you can connect with experts, join
              programs, and grow your skills and network.
            </Text>
            <Text style={paragraph}>
              Get started by exploring experts in your field, upcoming webinars,
              or browsing our community resources.
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={dashboardUrl}>
                Visit Your Dashboard
              </Button>
            </Section>
            <Text style={paragraph}>
              If you have any questions, simply reply to this email. We're here
              to help!
            </Text>
            <Text style={paragraph}>
              Warm regards,
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
