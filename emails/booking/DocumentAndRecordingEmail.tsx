import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import { documentReviewStatusBadge } from "@/lib/labels/session-labels";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type DocumentAndRecordingEmailKind =
  | "DOCUMENT_UPLOADED"
  | "DOCUMENT_REVIEWED"
  | "RECORDING_READY"
  | "RECORDING_FAILED"
  | "RECORDING_REMOVED";

export interface DocumentAndRecordingEmailProps {
  kind: DocumentAndRecordingEmailKind;
  recipientName?: string;
  actorName?: string;
  fileName?: string;
  versionNo?: number;
  reviewStatus?: string;
  reviewNotes?: string | null;
  appointmentType?: string;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

export function documentAndRecordingSubject(
  args: Pick<
    DocumentAndRecordingEmailProps,
    "kind" | "fileName" | "appointmentType"
  >,
): string {
  switch (args.kind) {
    case "DOCUMENT_UPLOADED":
      return `Document shared: ${args.fileName ?? "Session material"}`;
    case "DOCUMENT_REVIEWED":
      return `Document review update: ${args.fileName ?? "Session material"}`;
    case "RECORDING_READY":
      return `Recording ready for your ${args.appointmentType ?? "session"}`;
    case "RECORDING_FAILED":
      return "Session recording could not be saved";
    case "RECORDING_REMOVED":
      return `Recording removed: ${args.fileName ?? "Session recording"}`;
  }
}

export function DocumentAndRecordingEmail({
  kind,
  recipientName = "there",
  actorName,
  fileName = "your document",
  versionNo,
  reviewStatus,
  reviewNotes,
  appointmentType = "session",
  dashboardUrl,
  unsubscribeUrl,
}: Readonly<DocumentAndRecordingEmailProps>) {
  const subject = documentAndRecordingSubject({
    kind,
    fileName,
    appointmentType,
  });

  const actionLabel =
    kind === "RECORDING_READY" ? "Watch recording" : "Open session";

  return (
    <EmailLayout preview={subject} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>

      {kind === "DOCUMENT_UPLOADED" ? (
        <Text style={paragraph}>
          <strong>{actorName ?? "A session participant"}</strong> shared{" "}
          <strong>{fileName}</strong>
          {typeof versionNo === "number" && versionNo > 1
            ? ` (version ${versionNo})`
            : ""}
          . Open your booking to review it.
        </Text>
      ) : null}

      {kind === "DOCUMENT_REVIEWED" ? (
        <Text style={paragraph}>
          <strong>{actorName ?? "Your consultant"}</strong> updated{" "}
          <strong>{fileName}</strong>
          {reviewStatus ? (
            <>
              {" "}
              to{" "}
              <strong>
                {documentReviewStatusBadge(reviewStatus).label.toLowerCase()}
              </strong>
            </>
          ) : null}
          .
        </Text>
      ) : null}

      {kind === "DOCUMENT_REVIEWED" && reviewNotes ? (
        <Text style={paragraph}>
          Reviewer note: <em>{reviewNotes}</em>
        </Text>
      ) : null}

      {kind === "RECORDING_READY" ? (
        <Text style={paragraph}>
          The recording from your {appointmentType} is ready to view in your
          dashboard.
        </Text>
      ) : null}

      {kind === "RECORDING_FAILED" ? (
        <Text style={paragraph}>
          We could not finalize the video recording for your recent session. The
          session itself was unaffected.
        </Text>
      ) : null}

      {kind === "RECORDING_REMOVED" ? (
        <Text style={paragraph}>
          <strong>{actorName ?? "Your consultant"}</strong> removed the
          recording <strong>{fileName}</strong> from your session.
        </Text>
      ) : null}

      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          {actionLabel}
        </Button>
      </Section>
    </EmailLayout>
  );
}

export default DocumentAndRecordingEmail;
