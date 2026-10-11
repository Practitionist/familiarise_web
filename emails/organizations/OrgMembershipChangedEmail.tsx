import * as React from "react";
import { Button, Section, Text } from "react-email";
import type { MemberRole } from "@prisma/client";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";
import { MEMBER_ROLE_LABEL } from "@/lib/labels/org-labels";

export type OrgMembershipChangeKind =
  "ROLE_CHANGED" | "REMOVED" | "MEMBER_JOINED";

export interface OrgMembershipChangedEmailProps {
  recipientName?: string;
  kind: OrgMembershipChangeKind;
  orgName: string;
  roleBefore?: string;
  roleAfter?: string;
  actorName: string;
  memberEmail?: string;
  dashboardUrl: string;
  supportEmail: string;
}

/** Human label for a MemberRole value; unknown strings pass through. */
export function memberRoleLabel(role: string): string {
  return MEMBER_ROLE_LABEL[role as MemberRole] ?? role;
}

export function orgMembershipChangedSubject(args: {
  kind: OrgMembershipChangeKind;
  orgName: string;
  actorName?: string;
}): string {
  if (args.kind === "MEMBER_JOINED") {
    return `${args.actorName ?? "A new member"} joined ${args.orgName}`;
  }
  return args.kind === "REMOVED"
    ? `You were removed from ${args.orgName}`
    : `Your role in ${args.orgName} changed`;
}

function renderRoleTransition(
  beforeLabel: string | null,
  afterLabel: string | null,
): React.ReactNode {
  if (beforeLabel && afterLabel) {
    return (
      <>
        {" "}
        from <strong>{beforeLabel}</strong> to <strong>{afterLabel}</strong>
      </>
    );
  }
  if (afterLabel) {
    return (
      <>
        {" "}
        to <strong>{afterLabel}</strong>
      </>
    );
  }
  return null;
}

function renderMembershipChangeBody(args: {
  kind: OrgMembershipChangeKind;
  orgName: string;
  actorName: string;
  memberEmail?: string;
  beforeLabel: string | null;
  afterLabel: string | null;
}): React.ReactNode {
  const { kind, orgName, actorName, memberEmail, beforeLabel, afterLabel } =
    args;
  if (kind === "MEMBER_JOINED") {
    return (
      <Text style={paragraph}>
        <strong>{actorName}</strong>
        {memberEmail ? ` (${memberEmail})` : ""} accepted an invitation to join{" "}
        <strong>{orgName}</strong>
        {afterLabel ? (
          <>
            {" "}
            as <strong>{afterLabel}</strong>
          </>
        ) : null}
        .
      </Text>
    );
  }
  if (kind === "REMOVED") {
    return (
      <Text style={paragraph}>
        {actorName} removed you from <strong>{orgName}</strong>
        {beforeLabel ? (
          <>
            {" "}
            (you were a <strong>{beforeLabel}</strong>)
          </>
        ) : null}
        . You no longer have access to its dashboard, bookings, or resources.
      </Text>
    );
  }
  return (
    <Text style={paragraph}>
      {actorName} changed your role in <strong>{orgName}</strong>
      {renderRoleTransition(beforeLabel, afterLabel)}. Your permissions update
      the next time you sign in.
    </Text>
  );
}

// Required notice to the affected member or operator: role and roster changes
// affect workspace access.
export default function OrgMembershipChangedEmail({
  recipientName = "there",
  kind,
  orgName,
  roleBefore,
  roleAfter,
  actorName,
  memberEmail,
  dashboardUrl,
  supportEmail,
}: OrgMembershipChangedEmailProps) {
  const subject = orgMembershipChangedSubject({ kind, orgName, actorName });
  const beforeLabel = roleBefore ? memberRoleLabel(roleBefore) : null;
  const afterLabel = roleAfter ? memberRoleLabel(roleAfter) : null;
  return (
    <EmailLayout preview={subject} requiredNotice>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      {renderMembershipChangeBody({
        kind,
        orgName,
        actorName,
        memberEmail,
        beforeLabel,
        afterLabel,
      })}
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          Open dashboard
        </Button>
      </Section>
      <Text style={paragraph}>
        If this looks wrong, write to {supportEmail} and include the
        organisation name.
      </Text>
    </EmailLayout>
  );
}
