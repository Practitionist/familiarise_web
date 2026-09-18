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

export type OrgMembershipChangeKind = "ROLE_CHANGED" | "REMOVED";

export interface OrgMembershipChangedEmailProps {
  recipientName?: string;
  kind: OrgMembershipChangeKind;
  orgName: string;
  roleBefore?: string;
  roleAfter?: string;
  actorName: string;
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
}): string {
  return args.kind === "REMOVED"
    ? `You were removed from ${args.orgName}`
    : `Your role in ${args.orgName} changed`;
}

// Required notice to the affected member: role and roster changes affect
// access, so they cannot be muted.
export default function OrgMembershipChangedEmail({
  recipientName = "there",
  kind,
  orgName,
  roleBefore,
  roleAfter,
  actorName,
  dashboardUrl,
  supportEmail,
}: OrgMembershipChangedEmailProps) {
  const subject = orgMembershipChangedSubject({ kind, orgName });
  const beforeLabel = roleBefore ? memberRoleLabel(roleBefore) : null;
  const afterLabel = roleAfter ? memberRoleLabel(roleAfter) : null;
  return (
    <EmailLayout preview={subject} requiredNotice>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      {kind === "REMOVED" ? (
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
      ) : (
        <Text style={paragraph}>
          {actorName} changed your role in <strong>{orgName}</strong>
          {beforeLabel && afterLabel ? (
            <>
              {" "}
              from <strong>{beforeLabel}</strong> to{" "}
              <strong>{afterLabel}</strong>
            </>
          ) : afterLabel ? (
            <>
              {" "}
              to <strong>{afterLabel}</strong>
            </>
          ) : null}
          . Your permissions update the next time you sign in.
        </Text>
      )}
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
