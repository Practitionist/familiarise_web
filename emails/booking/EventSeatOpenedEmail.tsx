import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface EventSeatOpenedEmailProps {
  recipientName: string;
  planTitle: string;
  eventLabel: "webinar" | "class";
  startsText: string | null;
  checkoutUrl: string;
  unsubscribeUrl?: string | null;
}

/** A seat opened on a sold-out event the learner asked about; first to pay gets it. */
export default function EventSeatOpenedEmail({
  recipientName,
  planTitle,
  eventLabel,
  startsText,
  checkoutUrl,
  unsubscribeUrl,
}: EventSeatOpenedEmailProps) {
  const title = "A seat just opened";
  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        A seat opened in the {eventLabel} <strong>{planTitle}</strong>
        {startsText ? <>, starting {startsText}</> : null}. It may already be
        gone; first come, first served.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={checkoutUrl}>
          Get this seat
        </Button>
      </Section>
      <Text style={paragraph}>
        We send this the moment a seat opens, at any hour, to everyone waiting
        at once.
      </Text>
    </EmailLayout>
  );
}
