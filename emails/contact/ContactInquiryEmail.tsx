import * as React from "react";
import { Hr, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import { divider, heading, paragraph } from "@/emails/components/styles";

export interface ContactInquiryEmailProps {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  subject: string;
  message: string;
  category?: string | null;
  referenceNumber?: string | null;
}

export const ContactInquiryEmail = ({
  firstName,
  lastName,
  email,
  phone,
  subject,
  message,
  category,
  referenceNumber,
}: ContactInquiryEmailProps) => {
  const name = `${firstName} ${lastName}`.trim();
  const preview = referenceNumber
    ? `Grievance ${referenceNumber}: ${subject}`
    : `Contact inquiry: ${subject}`;

  return (
    <EmailLayout preview={preview} requiredNotice>
      <Text style={heading}>New contact inquiry</Text>
      {referenceNumber ? (
        <Text style={paragraph}>
          <strong>Reference:</strong> {referenceNumber}
        </Text>
      ) : null}
      <Text style={paragraph}>
        <strong>Name:</strong> {name}
        <br />
        <strong>Email:</strong> {email}
        <br />
        <strong>Phone:</strong> {phone || "—"}
        <br />
        <strong>Category:</strong> {category || "—"}
        <br />
        <strong>Subject:</strong> {subject}
      </Text>
      <Hr style={divider} />
      <Text style={{ ...paragraph, whiteSpace: "pre-wrap" }}>{message}</Text>
    </EmailLayout>
  );
};

export default ContactInquiryEmail;
