import { Button } from "@react-email/button";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Html } from "@react-email/html";
import { Img } from "@react-email/img";
import { Link } from "@react-email/link";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import * as React from "react";

interface AccountLinkedEmailProps {
  name: string;
  provider: string;
  dashboardUrl?: string;
}

export const AccountLinkedEmail = ({
  name = "Valued User",
  provider = "Google",
  dashboardUrl = "https://consultx.com/dashboard",
}: AccountLinkedEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>New sign-in method added to your ConsultX account</Preview>
      <Section style={main}>
        <Container style={container}>
          <Section>
            <Img
              src={`https://consultx.com/static/assets/logos/ConsultX-logos_transparent.png`}
              width="130"
              height="50"
              alt="ConsultX"
              style={logo}
            />
          </Section>
          <Section style={content}>
            <Text style={heading}>Account Successfully Linked</Text>
            <Text style={paragraph}>Hi {name},</Text>
            <Text style={paragraph}>
              We're letting you know that a new sign-in method has been added to
              your ConsultX account. You can now sign in using your {provider}{" "}
              account.
            </Text>
            <Text style={paragraph}>
              This provides you with more flexibility when accessing ConsultX
              and adds an additional layer of security to your account.
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={dashboardUrl}>
                Go to Dashboard
              </Button>
            </Section>
            <Text style={paragraph}>
              If you did not authorize this change, please contact our support
              team immediately at
              <Link href="mailto:support@consultx.com" style={link}>
                {" "}
                support@consultx.com
              </Link>
              .
            </Text>
            <Text style={paragraph}>
              Security regards,
              <br />
              The ConsultX Team
            </Text>
          </Section>
          <Section style={footer}>
            <Text style={footerText}>
              © 2023 ConsultX, All Rights Reserved
            </Text>
            <Text style={footerText}>
              Our mailing address:
              <br />
              123 ConsultX Way, Innovation District, Techville
            </Text>
            <Text style={footerLinks}>
              <Link href="https://consultx.com/privacy" style={link}>
                Privacy Policy
              </Link>{" "}
              •{" "}
              <Link href="https://consultx.com/terms" style={link}>
                Terms of Service
              </Link>
            </Text>
          </Section>
        </Container>
      </Section>
    </Html>
  );
};

export default AccountLinkedEmail;

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

const logo = {
  margin: "0 auto",
  display: "block",
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

const footer = {
  textAlign: "center" as const,
  margin: "20px 0",
};

const footerText = {
  fontSize: "12px",
  color: "#666",
  margin: "10px 0",
  lineHeight: "1.5",
};

const footerLinks = {
  fontSize: "12px",
  color: "#666",
  margin: "10px 0",
  lineHeight: "1.5",
};

const link = {
  color: "#666",
  textDecoration: "underline",
};
