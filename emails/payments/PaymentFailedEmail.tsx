import {
  Button,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "react-email";
import { formatCurrencyAmount } from "@/utils/formatting";
import * as React from "react";
import { getAppUrl } from "@/lib/url";
import { EmailFooter } from "@/emails/components/EmailFooter";
import { EmailLogo } from "@/emails/components/EmailLogo";
import { supportEmail } from "@/lib/email/config";

interface PaymentFailedEmailProps {
  name: string;
  consultantName: string;
  appointmentType: "consultation" | "subscription" | "webinar" | "class";
  amount: number;
  currency: string;
  retryUrl: string;
  failureReason?: string;
  expiresAt?: string; // ISO date string
}

export const PaymentFailedEmail = ({
  name = "Valued User",
  consultantName = "Expert Consultant",
  appointmentType = "consultation",
  amount = 100,
  currency = "USD",
  retryUrl = `${getAppUrl()}/payment`,
  failureReason = "Payment could not be processed",
  expiresAt,
}: PaymentFailedEmailProps) => {
  const previewText = `Payment failed for your ${appointmentType} with ${consultantName}`;
  const expiryDate = expiresAt
    ? new Date(expiresAt).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Section style={main}>
        <Container style={container}>
          <EmailLogo />
          <Section style={content}>
            <Section style={errorBanner}>
              <Text style={errorIcon}>⚠</Text>
              <Text style={errorHeading}>Payment Failed</Text>
            </Section>

            <Text style={paragraph}>Hi {name},</Text>
            <Text style={paragraph}>
              We were unable to process your payment for the {appointmentType}{" "}
              with <strong>{consultantName}</strong>.
            </Text>

            <Section style={errorDetails}>
              <Text style={errorLabel}>Reason:</Text>
              <Text style={errorMessage}>{failureReason}</Text>
            </Section>

            <Section style={paymentDetails}>
              <table style={detailsTable}>
                <tbody>
                  <tr>
                    <td style={detailLabel}>Amount:</td>
                    <td style={detailValue}>
                      {formatCurrencyAmount(amount, currency)}
                    </td>
                  </tr>
                  <tr>
                    <td style={detailLabel}>Type:</td>
                    <td style={detailValue}>
                      {appointmentType.charAt(0).toUpperCase() +
                        appointmentType.slice(1)}
                    </td>
                  </tr>
                  {expiryDate && (
                    <tr>
                      <td style={detailLabel}>Payment Link Expires:</td>
                      <td style={detailValue}>{expiryDate}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Section>

            <Text style={paragraph}>
              <strong>What to do next:</strong>
            </Text>
            <Text style={listItem}>
              • Check that your payment method has sufficient funds
            </Text>
            <Text style={listItem}>
              • Verify that your billing information is correct
            </Text>
            <Text style={listItem}>
              • Try using a different payment method if the issue persists
            </Text>

            <Section style={buttonContainer}>
              <Button style={button} href={retryUrl}>
                Retry Payment
              </Button>
            </Section>

            {expiresAt && (
              <Text style={warningText}>
                ⏰ <strong>Time Sensitive:</strong> This payment link will
                expire in 48 hours. If you don't complete the payment before
                then, your request will be reverted to pending status.
              </Text>
            )}

            <Hr style={divider} />

            <Text style={paragraph}>
              If you continue to experience issues or need help, please contact
              our support team:
            </Text>
            <Text style={paragraph}>
              <Link href={`mailto:${supportEmail()}`} style={supportLink}>
                {supportEmail()}
              </Link>
            </Text>

            <Text style={paragraph}>
              Best regards,
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

const errorBanner = {
  backgroundColor: "#fee2e2",
  padding: "20px",
  borderRadius: "5px",
  textAlign: "center" as const,
  margin: "0 0 30px",
  border: "2px solid #dc2626",
};

const errorIcon = {
  fontSize: "48px",
  color: "#dc2626",
  margin: "0 0 10px",
  lineHeight: "1",
};

const errorHeading = {
  fontSize: "24px",
  fontWeight: "bold",
  color: "#991b1b",
  lineHeight: "1.3",
  margin: "0",
};

const errorDetails = {
  backgroundColor: "#fef2f2",
  padding: "15px",
  borderRadius: "5px",
  margin: "20px 0",
  border: "1px solid #fecaca",
};

const errorLabel = {
  fontSize: "14px",
  color: "#991b1b",
  fontWeight: "600",
  margin: "0 0 5px",
};

const errorMessage = {
  fontSize: "14px",
  color: "#dc2626",
  margin: "0",
  fontStyle: "italic" as const,
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

const paymentDetails = {
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
  backgroundColor: "#dc2626",
  borderRadius: "5px",
  color: "#fff",
  fontSize: "16px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  padding: "14px 24px",
};

const warningText = {
  fontSize: "14px",
  lineHeight: "1.5",
  color: "#d97706",
  backgroundColor: "#fef3c7",
  padding: "12px",
  borderRadius: "5px",
  margin: "20px 0",
  border: "1px solid #fde68a",
};

const divider = {
  borderColor: "#e0e0e0",
  margin: "30px 0",
};

const supportLink = {
  color: "#2563eb",
  textDecoration: "underline",
  fontWeight: "600",
};
