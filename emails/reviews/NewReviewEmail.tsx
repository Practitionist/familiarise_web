import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface NewReviewEmailProps {
  consultantName: string;
  reviewerName: string;
  rating: number;
  /** The first 140 characters of the review text, when there is any. */
  excerpt?: string;
  reviewUrl: string;
  unsubscribeUrl?: string | null;
}

export function newReviewSubject({
  reviewerName,
  rating,
}: Pick<NewReviewEmailProps, "reviewerName" | "rating">): string {
  return `${reviewerName} left you a ${rating}-star review`;
}

export default function NewReviewEmail({
  consultantName,
  reviewerName,
  rating,
  excerpt,
  reviewUrl,
  unsubscribeUrl,
}: NewReviewEmailProps) {
  const subject = newReviewSubject({ reviewerName, rating });
  return (
    <EmailLayout preview={subject} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {consultantName},</Text>
      <Text style={paragraph}>
        {reviewerName} rated their time with you{" "}
        <strong>{rating} out of 5</strong>.
      </Text>
      {excerpt && (
        <Text style={paragraph}>
          <em>&ldquo;{excerpt}&rdquo;</em>
        </Text>
      )}
      <Text style={paragraph}>
        Reviews appear on your public profile. You can reply to this one from
        your dashboard.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={reviewUrl}>
          View review
        </Button>
      </Section>
    </EmailLayout>
  );
}
