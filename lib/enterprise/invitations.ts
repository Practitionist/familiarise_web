import crypto from "node:crypto";
import type { MemberRole } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  DomainVerificationRequiredError,
  UNVERIFIED_ORG_SEAT_CAP,
  hasVerifiedDomain,
} from "@/lib/enterprise/governance";
import {
  assertActorMayManage,
  MembershipGuardError,
} from "@/lib/enterprise/membership-guards";
import { notifyOrgInviteSent } from "@/lib/novu/org-workflows";
import { stageOrgInvitationEmail } from "@/lib/email";

/**
 * #1846 bucket C rule 3 — joining is invite + accept only. "Add people" and
 * bulk import both land here, so every human-initiated add is an Invitation
 * the person accepts (with the DPDP consent check at accept), never a
 * membership an operator switches on. SSO JIT and SCIM stay automatic.
 *
 * Runs inside the caller's Serializable transaction: the unverified-org seat
 * cap is a count-then-insert, and the pending-invite dedupe is a
 * read-then-write that the partial unique index on (organizationId,
 * lower(email)) WHERE status='pending' backstops.
 */

export interface IssueInvitationInput {
  orgId: string;
  orgName: string;
  /** Already trimmed and lowercased. */
  email: string;
  role: MemberRole;
  expiresAt: Date;
  inviter: {
    userId: string;
    name: string;
    membershipId: string;
    role: MemberRole;
  };
  /** Absolute origin for the accept link, e.g. https://familiarisenow.com. */
  origin: string;
}

/**
 * Creates the invitation, or refreshes the pending one for the same email,
 * and stages its bell and email in the same transaction. Refuses a person who
 * is already a member; a REMOVED member may be invited back, and accepting
 * reactivates their row. An ERASED member cannot be invited again.
 */
export async function issueInvitation(tx: Tx, input: IssueInvitationInput) {
  const { orgId, email, role, expiresAt, inviter } = input;
  // #1851 decision 6 — only an OWNER invites an OWNER, MAINTAINER or
  // BILLING_ADMIN; the accept route trusts the stored role.
  assertActorMayManage(
    { kind: "member", membershipId: inviter.membershipId, role: inviter.role },
    role,
    role,
  );

  const member = await tx.membership.findFirst({
    where: { organizationId: orgId, user: { email } },
    select: { status: true },
  });
  if (member && member.status !== "REMOVED") {
    throw new MembershipGuardError(
      "REMOVED_REQUIRES_REINVITE",
      member.status === "ERASED"
        ? "This person erased their data and cannot be invited again."
        : "This person is already a member of this organization.",
      409,
    );
  }

  const existing = await tx.invitation.findFirst({
    where: { organizationId: orgId, email, status: "pending" },
  });

  // PR-1d / #675: an unverified org onboards a small founding team and is
  // capped until a domain is verified. A re-invite is already counted.
  if (!existing && !(await hasVerifiedDomain(tx, orgId))) {
    const [activeMembers, pendingInvites] = await Promise.all([
      tx.membership.count({
        where: { organizationId: orgId, status: "ACTIVE" },
      }),
      tx.invitation.count({
        where: { organizationId: orgId, status: "pending" },
      }),
    ]);
    if (activeMembers + pendingInvites >= UNVERIFIED_ORG_SEAT_CAP) {
      throw new DomainVerificationRequiredError("BULK_SEATS");
    }
  }

  const record = existing
    ? await tx.invitation.update({
        where: { id: existing.id },
        data: { role, expiresAt },
      })
    : await tx.invitation.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: orgId,
          email,
          role,
          status: "pending",
          expiresAt,
          inviterId: inviter.userId,
        },
      });

  await tx.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: inviter.membershipId,
      category: "MEMBER",
      action: existing
        ? AUDIT_ACTIONS.MEMBER.INVITE_RESENT
        : AUDIT_ACTIONS.MEMBER.INVITE_SENT,
      description: `${existing ? "Re-sent" : "Sent"} invite to ${email} as ${role}`,
      details: { email, role, expiresAt: expiresAt.toISOString() },
    },
  });

  // The bell reaches an invitee who already has an account; the email
  // reaches one who does not (#1653). The link carries the invitation id,
  // which is the token the accept route redeems.
  const invite = {
    inviterName: inviter.name,
    orgName: input.orgName,
    role,
    inviteUrl: `${input.origin}/organizations/invite/${record.id}`,
    expiresAt: expiresAt.toISOString(),
  };
  const stagedBells = await notifyOrgInviteSent(email, invite, { tx });
  const stagedEmail = await stageOrgInvitationEmail(
    { email, ...invite },
    { tx, entityRef: `orgInvite:${record.id}` },
  );

  return {
    invitation: record,
    wasExisting: existing !== null,
    stagedBells,
    stagedEmail,
  };
}
