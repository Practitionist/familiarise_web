import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type CollaborationLifecycleEvent =
  "INVITED" | "ACCEPTED" | "DECLINED" | "REMOVED" | "WITHDRAWN" | "EXPIRED";

export interface CollaborationLifecycleEmailProps {
  recipientName?: string;
  event: CollaborationLifecycleEvent;
  actorName: string;
  collaboratorName?: string;
  planTitle: string;
  planKindLabel: string;
  roleLabel: string;
  revenueSharePct?: number;
  dashboardUrl: string;
}

export function collaborationLifecycleSubject(
  args: Readonly<{
    event: CollaborationLifecycleEvent;
    planTitle: string;
    collaboratorName?: string;
    roleLabel: string;
  }>,
): string {
  switch (args.event) {
    case "INVITED":
      return `Invitation to collaborate as ${args.roleLabel}: ${args.planTitle}`;
    case "ACCEPTED":
      return `${args.collaboratorName ?? "A collaborator"} accepted your ${args.roleLabel} invite for ${args.planTitle}`;
    case "DECLINED":
      return `${args.collaboratorName ?? "A collaborator"} declined your ${args.roleLabel} invite for ${args.planTitle}`;
    case "REMOVED":
      return `Your ${args.roleLabel} collaboration on ${args.planTitle} was removed`;
    case "WITHDRAWN":
      return `${args.collaboratorName ?? "A collaborator"} stepped down from ${args.planTitle}`;
    case "EXPIRED":
      return `Collaboration invite expired for ${args.planTitle}`;
  }
}

export default function CollaborationLifecycleEmail({
  recipientName = "there",
  event,
  actorName,
  collaboratorName,
  planTitle,
  planKindLabel,
  roleLabel,
  revenueSharePct,
  dashboardUrl,
}: Readonly<CollaborationLifecycleEmailProps>) {
  const subject = collaborationLifecycleSubject({
    event,
    planTitle,
    collaboratorName,
    roleLabel,
  });

  const shareText =
    typeof revenueSharePct === "number"
      ? `${revenueSharePct}% revenue share`
      : null;

  return (
    <EmailLayout preview={subject} requiredNotice>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>

      {event === "INVITED" ? (
        <Text style={paragraph}>
          <strong>{actorName}</strong> invited you to collaborate on the{" "}
          {planKindLabel.toLowerCase()} <strong>{planTitle}</strong> as{" "}
          <strong>{roleLabel}</strong>
          {shareText ? (
            <>
              {" "}
              with a <strong>{shareText}</strong>
            </>
          ) : null}
          . Review the schedule and accept or decline from your collaborations
          dashboard within 14 days.
        </Text>
      ) : null}

      {event === "ACCEPTED" ? (
        <Text style={paragraph}>
          <strong>{collaboratorName ?? actorName}</strong> accepted your
          invitation to join <strong>{planTitle}</strong> as{" "}
          <strong>{roleLabel}</strong>
          {shareText ? (
            <>
              {" "}
              (<strong>{shareText}</strong>)
            </>
          ) : null}
          . Collaborator chat and session access are now active.
        </Text>
      ) : null}

      {event === "DECLINED" ? (
        <Text style={paragraph}>
          <strong>{collaboratorName ?? actorName}</strong> declined your
          invitation to collaborate on <strong>{planTitle}</strong> as{" "}
          <strong>{roleLabel}</strong>. You can invite another collaborator from
          your plan settings.
        </Text>
      ) : null}

      {event === "REMOVED" ? (
        <Text style={paragraph}>
          <strong>{actorName}</strong> removed your <strong>{roleLabel}</strong>{" "}
          collaboration on <strong>{planTitle}</strong>. Existing settled
          earnings remain untouched, and future payments or session access no
          longer include your account.
        </Text>
      ) : null}

      {event === "WITHDRAWN" ? (
        <Text style={paragraph}>
          <strong>{collaboratorName ?? actorName}</strong> stepped down from{" "}
          <strong>{planTitle}</strong> (<strong>{roleLabel}</strong>). Their
          future revenue share returns to the plan owner pool, and their call
          and channel permissions have been revoked.
        </Text>
      ) : null}

      {event === "EXPIRED" ? (
        <Text style={paragraph}>
          The pending <strong>{roleLabel}</strong> collaboration invitation for{" "}
          <strong>{planTitle}</strong> expired after 14 days without a response.
        </Text>
      ) : null}

      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          {event === "INVITED" ? "Review invitation" : "Open collaborations"}
        </Button>
      </Section>
    </EmailLayout>
  );
}
