import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type SupportTicketEmailKind =
  "RESPONSE" | "STATUS_UPDATED" | "FEEDBACK_UPDATED";

export interface SupportTicketResponseEmailProps {
  kind?: SupportTicketEmailKind;
  recipientName: string;
  /** The ticket's human reference, e.g. "ST-2026-0142"; absent on a legacy row. */
  reference?: string;
  title: string;
  respondedBy?: string;
  /** The reply as typed; line breaks are preserved. */
  replyText?: string;
  statusLabel?: string;
  nextStepText?: string;
  ticketUrl: string;
  unsubscribeUrl?: string | null;
}

const PREVIEW_LENGTH = 140;

export function supportTicketResponseSubject({
  kind = "RESPONSE",
  respondedBy = "Support",
  reference,
  statusLabel,
}: Pick<
  SupportTicketResponseEmailProps,
  "kind" | "respondedBy" | "reference" | "statusLabel"
>): string {
  if (kind === "FEEDBACK_UPDATED") {
    return statusLabel
      ? `Your feedback is now ${statusLabel}`
      : "Update on your product feedback";
  }
  if (kind === "STATUS_UPDATED") {
    return reference
      ? `Your support case ${reference} is now ${statusLabel ?? "updated"}`
      : `Your support case is now ${statusLabel ?? "updated"}`;
  }
  return reference
    ? `${respondedBy} replied to your support case ${reference}`
    : `${respondedBy} replied to your support case`;
}

function renderFollowUpParagraph(
  kind: SupportTicketEmailKind,
  nextStepText?: string,
): React.ReactNode {
  if (kind === "RESPONSE") {
    return (
      <Text style={paragraph}>
        To reply, open the support case and write in the conversation. The
        support team sees your message as soon as it is sent.
      </Text>
    );
  }
  if (nextStepText) {
    return <Text style={paragraph}>{nextStepText}</Text>;
  }
  return null;
}

export default function SupportTicketResponseEmail({
  kind = "RESPONSE",
  recipientName,
  reference,
  title,
  respondedBy = "Support",
  replyText = "",
  statusLabel,
  nextStepText,
  ticketUrl,
  unsubscribeUrl,
}: SupportTicketResponseEmailProps) {
  const subject = supportTicketResponseSubject({
    kind,
    respondedBy,
    reference,
    statusLabel,
  });
  const previewSource = replyText || subject;
  const preview =
    previewSource.length > PREVIEW_LENGTH
      ? `${previewSource.slice(0, PREVIEW_LENGTH)}…`
      : previewSource;
  const lines = replyText ? replyText.split(/\r?\n/) : [];
  return (
    <EmailLayout preview={preview} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>

      {kind === "RESPONSE" ? (
        <Text style={paragraph}>
          {respondedBy} replied on your support case{" "}
          {reference && (
            <>
              <strong>{reference}</strong>{" "}
            </>
          )}
          ({title}):
        </Text>
      ) : null}

      {kind === "STATUS_UPDATED" ? (
        <Text style={paragraph}>
          Your support case{" "}
          {reference && (
            <>
              <strong>{reference}</strong>{" "}
            </>
          )}
          ({title}) is now <strong>{statusLabel ?? "updated"}</strong>.
        </Text>
      ) : null}

      {kind === "FEEDBACK_UPDATED" ? (
        <Text style={paragraph}>
          Your product feedback ({title}) is now{" "}
          <strong>{statusLabel ?? "updated"}</strong>.
        </Text>
      ) : null}

      {lines.length > 0 ? (
        <Section style={quote}>
          <Text style={quoteText}>
            {lines.map((line, index) => (
              <React.Fragment key={index}>
                {index > 0 && <br />}
                {line}
              </React.Fragment>
            ))}
          </Text>
        </Section>
      ) : null}

      {renderFollowUpParagraph(kind, nextStepText)}

      <Section style={buttonContainer}>
        <Button style={button} href={ticketUrl}>
          {kind === "FEEDBACK_UPDATED" ? "Open dashboard" : "View case"}
        </Button>
      </Section>
    </EmailLayout>
  );
}

const quote = {
  borderLeft: "3px solid #e0e0e0",
  padding: "0 0 0 16px",
  margin: "0 0 20px",
};

const quoteText = {
  ...paragraph,
  margin: "0",
};
