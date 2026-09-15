import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface NewBookingRequestEmailProps {
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  appointmentType: string;
  /** Pre-formatted in the recipient's zone. */
  requestedAtText?: string;
  respondByText?: string;
  reviewUrl: string;
  unsubscribeUrl?: string | null;
}

export default function NewBookingRequestEmail({
  consultantName,
  consulteeName,
  planTitle,
  appointmentType,
  requestedAtText,
  respondByText,
  reviewUrl,
  unsubscribeUrl,
}: NewBookingRequestEmailProps) {
  const title = `${consulteeName} requested a ${appointmentType} with you`;
  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {consultantName},</Text>
      <Text style={paragraph}>
        {consulteeName} requested a {appointmentType} for{" "}
        <strong>{planTitle}</strong>
        {requestedAtText ? (
          <>
            {" "}
            on <strong>{requestedAtText}</strong>
          </>
        ) : null}
        .
      </Text>
      <Text style={paragraph}>
        {respondByText
          ? `Please approve or decline it by ${respondByText}; an unanswered request expires and frees the time for other bookings.`
          : "Please approve or decline it soon; an unanswered request expires and frees the time for other bookings."}
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={reviewUrl}>
          Review request
        </Button>
      </Section>
    </EmailLayout>
  );
}
