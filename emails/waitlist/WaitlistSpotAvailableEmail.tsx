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

interface WaitlistSpotAvailableEmailProps {
  name: string;
  eventTitle: string;
  eventType: "webinar" | "class";
  scheduledDate?: string;
  expiresAt: string;
  bookNowUrl: string;
  declineUrl: string;
  skipUrl: string;
}

export const WaitlistSpotAvailableEmail = ({
  name = "Valued User",
  eventTitle = "Event",
  eventType = "webinar",
  scheduledDate,
  expiresAt,
  bookNowUrl = "https://familiarise.com/checkout",
  declineUrl = "https://familiarise.com/api/waitlist/decline",
  skipUrl = "https://familiarise.com/api/waitlist/skip",
}: WaitlistSpotAvailableEmailProps) => {
  const previewText = `A spot is available for ${eventTitle}! Book now before it's gone`;
  const eventTypeLabel = eventType === "webinar" ? "Webinar" : "Class";

  // Format expiration time
  const expirationDate = new Date(expiresAt);
  const formattedExpiration = expirationDate.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  // Format scheduled date if available
  const formattedScheduledDate = scheduledDate
    ? new Date(scheduledDate).toLocaleString("en-US", {
        dateStyle: "long",
        timeStyle: "short",
      })
    : null;

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Section style={main}>
        <Container style={container}>
          <Section>
            <Img
              src={`${process.env.NEXT_PUBLIC_APP_URL}/static/assets/logos/images/logos/Familiarise-logos_transparent.avif`}
              width="130"
              height="50"
              alt="Familiarise"
              style={logo}
            />
          </Section>
          <Section style={content}>
            <Section style={successBanner}>
              <Text style={successIcon}>🎉</Text>
              <Text style={successHeading}>A Spot is Available!</Text>
            </Section>

            <Text style={paragraph}>Hi {name},</Text>
            <Text style={paragraph}>
              Great news! A spot has opened up for <strong>{eventTitle}</strong>.
              You now have the opportunity to complete your registration!
            </Text>

            <Section style={urgentBox}>
              <Text style={urgentText}>
                ⏰ <strong>Act fast!</strong> This offer expires on{" "}
                <strong>{formattedExpiration}</strong>
              </Text>
            </Section>

            <Section style={details}>
              <table style={detailsTable}>
                <tbody>
                  <tr>
                    <td style={detailLabel}>{eventTypeLabel}:</td>
                    <td style={detailValue}>{eventTitle}</td>
                  </tr>
                  {formattedScheduledDate && (
                    <tr>
                      <td style={detailLabel}>Scheduled Date:</td>
                      <td style={detailValue}>{formattedScheduledDate}</td>
                    </tr>
                  )}
                  <tr>
                    <td style={detailLabel}>Offer Expires:</td>
                    <td style={detailValueUrgent}>{formattedExpiration}</td>
                  </tr>
                </tbody>
              </table>
            </Section>

            <Section style={buttonContainer}>
              <Button style={primaryButton} href={bookNowUrl}>
                Book Now
              </Button>
            </Section>

            <Text style={paragraphSmall}>
              Don't want this spot? You have options:
            </Text>
            <Text style={listItem}>
              •{" "}
              <Link href={skipUrl} style={link}>
                Skip this time
              </Link>{" "}
              - Move to the back of the queue
            </Text>
            <Text style={listItem}>
              •{" "}
              <Link href={declineUrl} style={link}>
                Leave waitlist
              </Link>{" "}
              - Remove yourself completely
            </Text>

            <Hr style={divider} />

            <Text style={paragraph}>
              If you don't respond before the deadline, you'll be automatically
              moved back in the queue and the next person will be notified.
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
              <Link href="https://familiarise.com/privacy" style={link}>
                Privacy Policy
              </Link>{" "}
              •{" "}
              <Link href="https://familiarise.com/terms" style={link}>
                Terms of Service
              </Link>
            </Text>
          </Section>
        </Container>
      </Section>
    </Html>
  );
};

export default WaitlistSpotAvailableEmail;

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

const successBanner = {
  backgroundColor: "#dcfce7",
  padding: "20px",
  borderRadius: "5px",
  textAlign: "center" as const,
  margin: "0 0 30px",
  border: "2px solid #16a34a",
};

const successIcon = {
  fontSize: "48px",
  margin: "0 0 10px",
  lineHeight: "1",
};

const successHeading = {
  fontSize: "24px",
  fontWeight: "bold",
  color: "#166534",
  lineHeight: "1.3",
  margin: "0",
};

const paragraph = {
  fontSize: "16px",
  lineHeight: "1.5",
  color: "#444",
  margin: "0 0 20px",
};

const paragraphSmall = {
  fontSize: "14px",
  lineHeight: "1.5",
  color: "#666",
  margin: "0 0 10px",
};

const listItem = {
  fontSize: "14px",
  lineHeight: "1.5",
  color: "#666",
  margin: "0 0 8px",
  paddingLeft: "0",
};

const urgentBox = {
  backgroundColor: "#fef3c7",
  padding: "15px",
  borderRadius: "5px",
  margin: "20px 0",
  border: "1px solid #f59e0b",
};

const urgentText = {
  fontSize: "14px",
  color: "#92400e",
  margin: "0",
  textAlign: "center" as const,
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
  backgroundColor: "#16a34a",
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
