import { Button } from "@react-email/button";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Hr } from "@react-email/hr";
import { Html } from "@react-email/html";
import { Img } from "@react-email/img";
import { Link } from "@react-email/link";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import * as React from "react";
import { getAppUrl } from "@/lib/url";

interface WaitlistJoinedEmailProps {
  name: string;
  eventTitle: string;
  eventType: "webinar" | "class";
  position: number;
  estimatedWait?: string;
  dashboardUrl?: string;
}

export const WaitlistJoinedEmail = ({
  name = "Valued User",
  eventTitle = "Event",
  eventType = "webinar",
  position = 1,
  estimatedWait,
  dashboardUrl = "https://familiarise.com/dashboard",
}: WaitlistJoinedEmailProps) => {
  const previewText = `You're #${position} on the waitlist for ${eventTitle}`;
  const eventTypeLabel = eventType === "webinar" ? "Webinar" : "Class";

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Section style={main}>
        <Container style={container}>
          <Section>
            <Img
              src={`${getAppUrl()}/static/assets/logos/images/logos/Familiarise-logos_transparent.avif`}
              width="130"
              height="50"
              alt="Familiarise"
              style={logo}
            />
          </Section>
          <Section style={content}>
            <Section style={infoBanner}>
              <Text style={infoIcon}>#</Text>
              <Text style={infoHeading}>Position {position}</Text>
            </Section>

            <Text style={paragraph}>Hi {name},</Text>
            <Text style={paragraph}>
              You've been added to the waitlist for{" "}
              <strong>{eventTitle}</strong>! We'll notify you as soon as a spot
              becomes available.
            </Text>

            <Section style={details}>
              <table style={detailsTable}>
                <tbody>
                  <tr>
                    <td style={detailLabel}>{eventTypeLabel}:</td>
                    <td style={detailValue}>{eventTitle}</td>
                  </tr>
                  <tr>
                    <td style={detailLabel}>Your Position:</td>
                    <td style={detailValue}>#{position}</td>
                  </tr>
                  {estimatedWait && (
                    <tr>
                      <td style={detailLabel}>Estimated Wait:</td>
                      <td style={detailValue}>{estimatedWait}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Section>

            <Text style={paragraph}>
              <strong>What happens next?</strong>
            </Text>
            <Text style={listItem}>
              • When a spot opens up, you'll receive an email notification
            </Text>
            <Text style={listItem}>
              • You'll have 48 hours to complete your registration
            </Text>
            <Text style={listItem}>
              • If you miss the window, you'll be moved back in the queue
            </Text>

            <Section style={buttonContainer}>
              <Button style={button} href={dashboardUrl}>
                View My Waitlists
              </Button>
            </Section>

            <Hr style={divider} />

            <Text style={paragraph}>
              You can view and manage your waitlist entries from your{" "}
              <Link href={dashboardUrl} style={link}>
                dashboard
              </Link>
              .
            </Text>

            <Text style={paragraph}>
              Best regards,
              <br />
              The Familiarise Team
            </Text>
          </Section>
          <Section style={footer}>
            <Text style={footerText}>
              © 2023 Familiarise, All Rights Reserved
            </Text>
            <Text style={footerLinks}>
              <Link href={`${getAppUrl()}/privacy`} style={link}>
                Privacy Policy
              </Link>{" "}
              •{" "}
              <Link href={`${getAppUrl()}/terms`} style={link}>
                Terms of Service
              </Link>
            </Text>
          </Section>
        </Container>
      </Section>
    </Html>
  );
};

export default WaitlistJoinedEmail;

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

const infoBanner = {
  backgroundColor: "#fef3c7",
  padding: "20px",
  borderRadius: "5px",
  textAlign: "center" as const,
  margin: "0 0 30px",
  border: "2px solid #f59e0b",
};

const infoIcon = {
  fontSize: "48px",
  color: "#d97706",
  margin: "0 0 10px",
  lineHeight: "1",
  fontWeight: "bold",
};

const infoHeading = {
  fontSize: "24px",
  fontWeight: "bold",
  color: "#92400e",
  lineHeight: "1.3",
  margin: "0",
};

const paragraph = {
  fontSize: "16px",
  lineHeight: "1.5",
  color: "#444",
  margin: "0 0 20px",
};

const listItem = {
  fontSize: "16px",
  lineHeight: "1.5",
  color: "#444",
  margin: "0 0 10px",
  paddingLeft: "0",
};

const details = {
  backgroundColor: "#f9f9f9",
  padding: "20px",
  borderRadius: "5px",
  margin: "20px 0",
  border: "1px solid #e0e0e0",
};

const detailsTable = {
  width: "100%",
  borderCollapse: "collapse" as const,
};

const detailLabel = {
  fontSize: "14px",
  color: "#666",
  padding: "8px 0",
  width: "40%",
};

const detailValue = {
  fontSize: "16px",
  color: "#333",
  fontWeight: "600",
  padding: "8px 0",
};

const buttonContainer = {
  textAlign: "center" as const,
  margin: "30px 0",
};

const button = {
  backgroundColor: "#f59e0b",
  borderRadius: "5px",
  color: "#fff",
  fontSize: "16px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  padding: "14px 24px",
};

const divider = {
  borderColor: "#e0e0e0",
  margin: "30px 0",
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
