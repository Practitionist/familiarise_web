import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type OrgOperationalEmailKind =
  | "MEMBER_OVERAGE_TIMED_OUT"
  | "LICENSE_RENEWAL_UPCOMING"
  | "PROGRAM_CAP_NEAR"
  | "PROGRAM_EXHAUSTED"
  | "DATA_EXPORT_READY";

export interface OrgDunningEmailProps {
  kind: OrgOperationalEmailKind;
  recipientName?: string;
  orgName: string;
  programName?: string;
  assigneeName?: string;
  amountText?: string;
  expectedTotalText?: string;
  renewalDateText?: string;
  expiresAtText?: string;
  daysUntilRenewal?: number;
  cycle?: string;
  engagementsUsed?: number;
  cap?: number;
  usedPct?: number;
  actionUrl: string;
  unsubscribeUrl?: string | null;
}

export function orgOperationalEmailSubject(
  args: Pick<
    OrgDunningEmailProps,
    "kind" | "orgName" | "programName" | "daysUntilRenewal"
  >,
): string {
  switch (args.kind) {
    case "MEMBER_OVERAGE_TIMED_OUT":
      return `Payment window closed for ${args.programName ?? "programme"} at ${args.orgName}`;
    case "LICENSE_RENEWAL_UPCOMING": {
      if (typeof args.daysUntilRenewal !== "number") {
        return `Upcoming licence renewal for ${args.orgName}`;
      }
      const dayUnit = args.daysUntilRenewal === 1 ? "day" : "days";
      return `Licence renewal in ${args.daysUntilRenewal} ${dayUnit} for ${args.orgName}`;
    }
    case "PROGRAM_CAP_NEAR":
      return `Programme allowance nearly used up: ${args.programName ?? args.orgName}`;
    case "PROGRAM_EXHAUSTED":
      return `Programme allowance reached: ${args.programName ?? args.orgName}`;
    case "DATA_EXPORT_READY":
      return `Your data export for ${args.orgName} is ready`;
  }
}

const DUNNING_BUTTON_LABEL: Record<OrgOperationalEmailKind, string> = {
  MEMBER_OVERAGE_TIMED_OUT: "Open billing",
  LICENSE_RENEWAL_UPCOMING: "Open workspace",
  PROGRAM_CAP_NEAR: "Open workspace",
  PROGRAM_EXHAUSTED: "Open workspace",
  DATA_EXPORT_READY: "Download export",
};

function renderOrgDunningBody(args: {
  kind: OrgOperationalEmailKind;
  orgName: string;
  programName?: string;
  assigneeName?: string;
  amountText?: string;
  expectedTotalText?: string;
  renewalDateText?: string;
  expiresAtText?: string;
  cycle?: string;
  engagementsUsed?: number;
  cap?: number;
  usedPct?: number;
}): React.ReactNode {
  const {
    kind,
    orgName,
    programName,
    assigneeName,
    amountText,
    expectedTotalText,
    renewalDateText,
    expiresAtText,
    cycle,
    engagementsUsed,
    cap,
    usedPct,
  } = args;

  switch (kind) {
    case "MEMBER_OVERAGE_TIMED_OUT":
      return (
        <Text style={paragraph}>
          The payment window for your{" "}
          <strong>{programName ?? "programme"}</strong> overage
          {amountText ? (
            <>
              {" "}
              of <strong>{amountText}</strong>
            </>
          ) : null}{" "}
          at <strong>{orgName}</strong> has closed. Contact your programme
          administrator if you still need to schedule this session.
        </Text>
      );
    case "LICENSE_RENEWAL_UPCOMING":
      return (
        <Text style={paragraph}>
          <strong>{orgName}</strong>&apos;s{" "}
          {cycle ? `${cycle.toLowerCase()} ` : ""}enterprise licence renews
          {renewalDateText ? (
            <>
              {" "}
              on <strong>{renewalDateText}</strong>
            </>
          ) : null}
          {expectedTotalText ? (
            <>
              {" "}
              for an estimated <strong>{expectedTotalText}</strong>
            </>
          ) : null}
          . Review your active seats and billing method ahead of renewal.
        </Text>
      );
    case "PROGRAM_CAP_NEAR":
      return (
        <Text style={paragraph}>
          <strong>{assigneeName ?? "A member"}</strong> has used{" "}
          <strong>
            {engagementsUsed ?? 0} of {cap ?? 0}
          </strong>{" "}
          engagements
          {typeof usedPct === "number" ? ` (${usedPct}%)` : ""} in{" "}
          <strong>{programName ?? "your programme"}</strong> at{" "}
          <strong>{orgName}</strong>.
        </Text>
      );
    case "PROGRAM_EXHAUSTED":
      return (
        <Text style={paragraph}>
          <strong>{assigneeName ?? "A member"}</strong> has used their full
          allowance in <strong>{programName ?? "your programme"}</strong> at{" "}
          <strong>{orgName}</strong>. Additional bookings will require raising
          the programme cap or member co-pay.
        </Text>
      );
    case "DATA_EXPORT_READY":
      return (
        <Text style={paragraph}>
          Your requested data export for <strong>{orgName}</strong> is ready to
          download
          {expiresAtText ? (
            <>
              . The download link expires on <strong>{expiresAtText}</strong>
            </>
          ) : null}
          .
        </Text>
      );
  }
}

export function OrgDunningEmail({
  kind,
  recipientName = "there",
  orgName,
  programName,
  assigneeName,
  amountText,
  expectedTotalText,
  renewalDateText,
  expiresAtText,
  daysUntilRenewal,
  cycle,
  engagementsUsed,
  cap,
  usedPct,
  actionUrl,
  unsubscribeUrl,
}: Readonly<OrgDunningEmailProps>) {
  const subject = orgOperationalEmailSubject({
    kind,
    orgName,
    programName,
    daysUntilRenewal,
  });

  const buttonLabel = DUNNING_BUTTON_LABEL[kind];

  return (
    <EmailLayout preview={subject} unsubscribeUrl={unsubscribeUrl} showSupport>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>

      {renderOrgDunningBody({
        kind,
        orgName,
        programName,
        assigneeName,
        amountText,
        expectedTotalText,
        renewalDateText,
        expiresAtText,
        cycle,
        engagementsUsed,
        cap,
        usedPct,
      })}

      <Section style={buttonContainer}>
        <Button style={button} href={actionUrl}>
          {buttonLabel}
        </Button>
      </Section>
    </EmailLayout>
  );
}

export default OrgDunningEmail;
