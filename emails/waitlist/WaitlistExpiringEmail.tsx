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

interface WaitlistExpiringEmailProps {
  name: string;
  eventTitle: string;
  eventType: "webinar" | "class";
  expiresAt: string;
  bookNowUrl: string;
}

export const WaitlistExpiringEmail = ({
  name = "Valued User",
  eventTitle = "Event",
  eventType = "webinar",
  expiresAt,
  bookNowUrl = "https://familiarise.com/checkout",
}: WaitlistExpiringEmailProps) => {
  const previewText = `Reminder: Your spot for ${eventTitle} expires in 12 hours!`;
  const eventTypeLabel = eventType === "webinar" ? "Webinar" : "Class";

  // Format expiration time
  const expirationDate = new Date(expiresAt);
  const formattedExpiration = expirationDate.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

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
            <Section style={warningBanner}>
              <Text style={warningIcon}>⏰</Text>
              <Text style={warningHeading}>Time Running Out!</Text>
            </Section>

            <Text style={paragraph}>Hi {name},</Text>
            <Text style={paragraph}>
              This is a friendly reminder that your opportunity to book{" "}
              <strong>{eventTitle}</strong> is expiring soon. Don't miss out!
            </Text>

            <Section style={urgentBox}>
              <Text style={urgentText}>
                ⚠️ <strong>Only ~12 hours left!</strong>
              </Text>
              <Text style={urgentSubtext}>
                Expires: <strong>{formattedExpiration}</strong>
              </Text>
            </Section>

            <Section style={details}>
              <table style={detailsTable}>
                <tbody>
                  <tr>
                    <td style={detailLabel}>{eventTypeLabel}:</td>
                    <td style={detailValue}>{eventTitle}</td>
                  </tr>
                  <tr>
                    <td style={detailLabel}>Deadline:</td>
                    <td style={detailValueUrgent}>{formattedExpiration}</td>
                  </tr>
                </tbody>
              </table>
            </Section>

            <Section style={buttonContainer}>
              <Button style={primaryButton} href={bookNowUrl}>
                Complete My Booking
              </Button>
            </Section>

            <Text style={paragraph}>
              If you don't complete your booking before the deadline, you'll
              automatically be moved back in the waitlist queue and the next
              person will be offered this spot.
            </Text>

            <Hr style={divider} />

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

const warningBanner = {
  backgroundColor: "#fef3c7",
  padding: "20px",
  borderRadius: "5px",
  textAlign: "center" as const,
  margin: "0 0 30px",
  border: "2px solid #f59e0b",
};

const warningIcon = {
  fontSize: "48px",
  margin: "0 0 10px",
  lineHeight: "1",
};

const warningHeading = {
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

const urgentBox = {
  backgroundColor: "#fef2f2",
  padding: "20px",
  borderRadius: "5px",
  margin: "20px 0",
  border: "2px solid #dc2626",
  textAlign: "center" as const,
};

const urgentText = {
  fontSize: "18px",
  color: "#dc2626",
  margin: "0 0 5px",
  fontWeight: "bold",
};

const urgentSubtext = {
  fontSize: "14px",
  color: "#991b1b",
  margin: "0",
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

const detailValueUrgent = {
  fontSize: "16px",
  color: "#dc2626",
  fontWeight: "600",
  padding: "8px 0",
};

const buttonContainer = {
  textAlign: "center" as const,
  margin: "30px 0",
};

const primaryButton = {
  backgroundColor: "#dc2626",
  borderRadius: "5px",
  color: "#fff",
  fontSize: "18px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  padding: "16px 32px",
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
