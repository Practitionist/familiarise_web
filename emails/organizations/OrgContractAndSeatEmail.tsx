import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type OrgContractAndSeatEmailKind =
  | "SEAT_ASSIGNED"
  | "SEAT_REVOKED"
  | "CONTRACT_ACTIVATED"
  | "CONTRACT_RENEWED"
  | "CONTRACT_ENDED"
  | "COMPLIANCE_ALERT";

export interface OrgContractAndSeatEmailProps {
  kind: OrgContractAndSeatEmailKind;
  recipientName?: string;
  orgName?: string;
  programName?: string;
  title?: string;
  dueDateText?: string;
  effectiveDateText?: string;
  reason?: string | null;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

export function orgContractAndSeatSubject(
  args: Pick<
    OrgContractAndSeatEmailProps,
    "kind" | "orgName" | "programName" | "title"
  >,
): string {
  switch (args.kind) {
    case "SEAT_ASSIGNED":
      return `Programme seat assigned: ${args.programName ?? args.orgName ?? "Familiarise"}`;
    case "SEAT_REVOKED":
      return `Programme seat ended: ${args.programName ?? args.orgName ?? "Familiarise"}`;
    case "CONTRACT_ACTIVATED":
      return `Enterprise contract activated for ${args.orgName ?? "your organisation"}`;
    case "CONTRACT_RENEWED":
      return `Enterprise contract renewed for ${args.orgName ?? "your organisation"}`;
    case "CONTRACT_ENDED":
      return `Enterprise contract ended for ${args.orgName ?? "your organisation"}`;
    case "COMPLIANCE_ALERT":
      return `Compliance deadline alert: ${args.title ?? "Action required"}`;
  }
}

function renderContractAndSeatBody(args: {
  kind: OrgContractAndSeatEmailKind;
  orgName: string | undefined;
  programName: string;
  title?: string;
  dueDateText?: string;
  effectiveDateText?: string;
}): React.ReactNode {
  const { kind, orgName, programName, title, dueDateText, effectiveDateText } =
    args;
  switch (kind) {
    case "SEAT_ASSIGNED":
      return (
        <Text style={paragraph}>
          You have been assigned a seat in <strong>{programName}</strong> at{" "}
          <strong>{orgName}</strong>. Open your workspace dashboard to view
          eligible experts and book sessions.
        </Text>
      );
    case "SEAT_REVOKED":
      return (
        <Text style={paragraph}>
          Your seat in <strong>{programName}</strong> at{" "}
          <strong>{orgName}</strong> has ended.
        </Text>
      );
    case "CONTRACT_ACTIVATED":
      return (
        <Text style={paragraph}>
          The enterprise agreement for <strong>{orgName}</strong> is now active
          {effectiveDateText ? (
            <>
              {" "}
              (effective <strong>{effectiveDateText}</strong>)
            </>
          ) : null}
          .
        </Text>
      );
    case "CONTRACT_RENEWED":
      return (
        <Text style={paragraph}>
          The enterprise agreement for <strong>{orgName}</strong> has been
          renewed
          {effectiveDateText ? (
            <>
              {" "}
              effective <strong>{effectiveDateText}</strong>
            </>
          ) : null}
          .
        </Text>
      );
    case "CONTRACT_ENDED":
      return (
        <Text style={paragraph}>
          The enterprise agreement for <strong>{orgName}</strong> has concluded
          {effectiveDateText ? (
            <>
              {" "}
              as of <strong>{effectiveDateText}</strong>
            </>
          ) : null}
          .
        </Text>
      );
    case "COMPLIANCE_ALERT":
      return (
        <Text style={paragraph}>
          <strong>{title ?? "A statutory compliance obligation"}</strong>
          {orgName ? (
            <>
              {" "}
              for <strong>{orgName}</strong>
            </>
          ) : null}{" "}
          is due
          {dueDateText ? (
            <>
              {" "}
              on <strong>{dueDateText}</strong>
            </>
          ) : (
            " soon"
          )}
          . Review the compliance dashboard to complete filing before the
          statutory deadline.
        </Text>
      );
  }
}

export function OrgContractAndSeatEmail({
  kind,
  recipientName = "there",
  orgName: orgNameProp,
  programName = "your programme",
  title,
  dueDateText,
  effectiveDateText,
  reason,
  dashboardUrl,
  unsubscribeUrl,
}: Readonly<OrgContractAndSeatEmailProps>) {
  const orgName =
    orgNameProp ??
    (kind === "COMPLIANCE_ALERT" ? undefined : "your organisation");
  const subject = orgContractAndSeatSubject({
    kind,
    orgName,
    programName,
    title,
  });

  const requiredNotice = kind === "COMPLIANCE_ALERT";

  return (
    <EmailLayout
      preview={subject}
      requiredNotice={requiredNotice}
      unsubscribeUrl={requiredNotice ? undefined : unsubscribeUrl}
    >
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>

      {renderContractAndSeatBody({
        kind,
        orgName,
        programName,
        title,
        dueDateText,
        effectiveDateText,
      })}

      {reason ? (
        <Text style={paragraph}>
          Note: <em>{reason}</em>
        </Text>
      ) : null}

      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          {kind === "COMPLIANCE_ALERT" ? "Open compliance" : "Open workspace"}
        </Button>
      </Section>
    </EmailLayout>
  );
}

export default OrgContractAndSeatEmail;
