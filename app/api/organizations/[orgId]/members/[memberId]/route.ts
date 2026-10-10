/**
 * GET    /api/organizations/[orgId]/members/[memberId]
 * PATCH  /api/organizations/[orgId]/members/[memberId]
 * DELETE /api/organizations/[orgId]/members/[memberId]
 *
 * `memberId` is a `Membership.id` (not a User id). Operations produce an
 * audit log row in the same transaction as the mutation.
 *
 * Every role and status move goes through the shared membership guard
 * (`lib/enterprise/membership-guards.ts`, #1846 bucket C), and removal, by
 * DELETE or by PATCH `status: REMOVED`, goes through the one removal path in
 * `lib/enterprise/member-removal.ts` (ORG-07).
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  IllegalTransitionError,
  transitionMembership,
} from "@/lib/enterprise/transitions";
import {
  MembershipGuardError,
  assertNotTombstone,
  assertRoleChangeAllowed,
  assertStatusChangeAllowed,
} from "@/lib/enterprise/membership-guards";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { removeMember } from "@/lib/enterprise/member-removal";
import {
  applyMembershipRoleEffects,
  auditPayoutRecipientChange,
  recomputeIndependenceAcross,
} from "@/lib/api/organizations/membership-transitions";
import {
  attemptOnboardingEmail,
  stageOrgMembershipChangedEmail,
  type StagedOnboardingEmail,
} from "@/lib/email";
import { scheduleAfter } from "@/lib/api/after-safe";
import { getAppUrl } from "@/lib/url";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";

// Mirror the full Prisma MemberRole enum. The earlier hand-rolled list
// omitted BILLING_ADMIN — invitable but un-PATCH-able
// here, so OWNERs couldn't promote a MAINTAINER to BILLING_ADMIN via
// the dashboard ("Invalid body" 400). Caught during the 2026-06 role
// audit. We could import lib/labels/org-labels.ts:MemberRoleSchema to
// share the source — kept local for now to avoid cross-cutting churn,
// but the values MUST stay in sync with the Prisma enum + the shared
// schema or we re-introduce the same drift bug.
const MemberRoleSchema = z.enum([
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
  "EXPERT",
  "LEARNER",
  "SUPPORT",
]);

const MemberStatusSchema = z.enum([
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "REMOVED",
]);

const PatchBodySchema = z
  .object({
    role: MemberRoleSchema.optional(),
    status: MemberStatusSchema.optional(),
    departmentLabel: z.string().max(100).nullable().optional(),
    // #729 — explicit EXPERT payout routing. Only applied when the effective
    // role is EXPERT (otherwise ignored); overrides the role-change default.
    payoutRecipient: z.enum(["SELF", "ORGANIZATION"]).optional(),
  })
  .refine(
    (v) =>
      v.role !== undefined ||
      v.status !== undefined ||
      v.departmentLabel !== undefined ||
      v.payoutRecipient !== undefined,
    {
      message:
        "PATCH body must contain at least one of role/status/departmentLabel/payoutRecipient",
    },
  );

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; memberId: string }>;
  },
) {
  const { orgId, memberId } = await params;
  // `members.read` (the same grant as the member list) can read other
  // members' details; everyone else only THEIR OWN membership, so no member
  // can enumerate peers' emails/profile ids. Was a MANAGER rank floor, which
  // let BILLING_ADMIN open members the list refuses and kept SUPPORT out of
  // members it can list (#1527 P0-4).
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;

  const membership = await prisma.membership.findFirst({
    where: { id: memberId, organizationId: orgId },
    include: {
      user: {
        select: { id: true, name: true, email: true, image: true },
      },
      consulteeProfile: { select: { id: true } },
      consultantProfile: { select: { id: true } },
    },
  });
  if (!membership) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const isSelf = membership.id === access.member.id;
  if (!isSelf && !hasOrgPermission(access.member.role, "members.read")) {
    return NextResponse.json(
      { error: "Insufficient role to view other members" },
      { status: 403 },
    );
  }

  // #1851 — payout routing and the rate-card override are finance data; the
  // member list already hides them without `payouts.read`, and the detail
  // now matches it (MANAGER and SUPPORT read members, not their pay).
  const canSeePay =
    isSelf || hasOrgPermission(access.member.role, "payouts.read");
  return NextResponse.json({
    membership: canSeePay
      ? membership
      : {
          ...membership,
          payoutRecipient: undefined,
          rateCardOverrideId: undefined,
        },
  });
}

type MemberPatch = z.infer<typeof PatchBodySchema>;
type MemberRow = Awaited<
  ReturnType<typeof prisma.membership.findUniqueOrThrow>
>;

/** The non-status columns a PATCH writes. */
function memberUpdateData(
  patch: MemberPatch,
  currentRole: MemberRow["role"],
  roleEffects: Awaited<ReturnType<typeof applyMembershipRoleEffects>> | null,
) {
  // #729 — an explicit payout-recipient choice counts only when the resulting
  // role is EXPERT, and wins over the role-change default below it.
  const explicitPayout =
    patch.payoutRecipient !== undefined &&
    (patch.role ?? currentRole) === "EXPERT"
      ? patch.payoutRecipient
      : undefined;
  return {
    ...(patch.role !== undefined && { role: patch.role }),
    ...(patch.departmentLabel !== undefined && {
      departmentLabel: patch.departmentLabel,
    }),
    ...(roleEffects && {
      consulteeProfileId: roleEffects.consulteeProfileId,
      consultantProfileId: roleEffects.consultantProfileId,
      payoutRecipient: roleEffects.payoutRecipient,
    }),
    ...(explicitPayout !== undefined && { payoutRecipient: explicitPayout }),
  };
}

/** The audit rows a PATCH writes, in the same transaction as the change. */
async function auditMemberChange(
  tx: Tx,
  args: {
    orgId: string;
    actorMembershipId: string;
    current: MemberRow;
    updated: MemberRow;
    patch: MemberPatch;
    roleChanged: boolean;
    statusChanged: boolean;
  },
): Promise<void> {
  const { current, updated, patch } = args;
  const base = {
    organizationId: args.orgId,
    actorMembershipId: args.actorMembershipId,
    targetMembershipId: current.id,
  };
  // #1851 decision 5 — a payout-recipient change is a money event: its own
  // PAYOUT-category row, visible to the finance readers.
  if (updated.payoutRecipient !== current.payoutRecipient) {
    await auditPayoutRecipientChange(tx, {
      ...base,
      from: current.payoutRecipient,
      to: updated.payoutRecipient,
      viaRoleChange: args.roleChanged,
    });
  }
  const details = {
    from: { role: current.role, status: current.status },
    to: {
      role: patch.role ?? current.role,
      status: patch.status ?? current.status,
    },
  };
  if (args.roleChanged) {
    await tx.orgAuditLog.create({
      data: {
        ...base,
        category: "MEMBER",
        action: AUDIT_ACTIONS.MEMBER.ROLE_CHANGE,
        description: `Role: ${current.role} → ${patch.role}`,
        details,
      },
    });
  }
  if (args.statusChanged) {
    await tx.orgAuditLog.create({
      data: {
        ...base,
        category: "MEMBER",
        action: AUDIT_ACTIONS.MEMBER.STATUS_CHANGE,
        description: `Status: ${current.status} → ${patch.status}`,
        details,
      },
    });
  }
}

/** Maps a guard refusal or an `httpStatus`-tagged error onto the response. */
function errorResponse(err: unknown): NextResponse | null {
  if (err instanceof MembershipGuardError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        ...(err.counts && { counts: err.counts }),
      },
      { status: err.httpStatus },
    );
  }
  if (err instanceof IllegalTransitionError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.httpStatus },
    );
  }
  if (err instanceof Error && "httpStatus" in err) {
    const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
  return null;
}

function reportAndRethrow(err: unknown): never {
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
    tags: { subsystem: "organizations" },
  });
  throw err;
}

async function emitMembershipStatusWebhook(
  tx: Tx,
  args: {
    orgId: string;
    memberId: string;
    statusChanged: boolean;
    previousStatus: MemberRow["status"];
    nextStatus: MemberPatch["status"];
    userId: string;
    role: MemberRow["role"];
  },
): Promise<void> {
  if (!args.statusChanged) return;
  if (args.previousStatus === "ACTIVE" && args.nextStatus === "SUSPENDED") {
    await dispatchWebhookEvent({
      prisma: tx,
      organizationId: args.orgId,
      eventType: "member.removed",
      payload: {
        membershipId: args.memberId,
        userId: args.userId,
        role: args.role,
        previousStatus: "ACTIVE",
        reason: "suspended",
      },
    });
  } else if (
    args.previousStatus === "SUSPENDED" &&
    args.nextStatus === "ACTIVE"
  ) {
    await dispatchWebhookEvent({
      prisma: tx,
      organizationId: args.orgId,
      eventType: "member.added",
      payload: {
        membershipId: args.memberId,
        userId: args.userId,
        role: args.role,
        previousStatus: "SUSPENDED",
        source: "reactivated",
      },
    });
  }
}

async function applyRoleAndStatusTransitions(
  tx: Tx,
  args: {
    orgId: string;
    memberId: string;
    current: MemberRow;
    patch: MemberPatch;
    actor: { kind: "member"; membershipId: string; role: MemberRow["role"] };
    org: Parameters<typeof assertRoleChangeAllowed>[1]["org"];
    roleChanged: boolean;
    statusChanged: boolean;
  },
): Promise<Awaited<ReturnType<typeof applyMembershipRoleEffects>> | null> {
  const { current, patch, actor, orgId, memberId } = args;
  let roleEffects: Awaited<
    ReturnType<typeof applyMembershipRoleEffects>
  > | null = null;

  if (args.roleChanged && patch.role !== undefined) {
    await assertRoleChangeAllowed(tx, {
      membership: current,
      to: patch.role,
      actor,
      org: args.org,
    });
    roleEffects = await applyMembershipRoleEffects(tx, {
      userId: current.userId,
      role: patch.role,
    });
  }

  if (args.statusChanged && patch.status !== undefined) {
    await assertStatusChangeAllowed(tx, {
      membership: current,
      to: patch.status,
      actor,
    });
    await transitionMembership(tx, {
      where: { id: memberId, organizationId: orgId },
      to: patch.status,
    });
  }

  return roleEffects;
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; memberId: string }>;
  },
) {
  const { orgId, memberId } = await params;
  const access = await requireOrgAccess(orgId, { requireActive: true });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const patch = parsed.data;

  const touchesPeople =
    patch.role !== undefined ||
    patch.status !== undefined ||
    patch.departmentLabel !== undefined;
  if (
    touchesPeople &&
    !hasOrgPermission(access.member.role, "members.manage")
  ) {
    return NextResponse.json(
      { error: "Insufficient role to manage members" },
      { status: 403 },
    );
  }
  if (
    patch.payoutRecipient !== undefined &&
    !hasOrgPermission(access.member.role, "members.payoutRecipient.change")
  ) {
    return NextResponse.json(
      {
        error:
          "Only an Owner or Billing admin can change where an expert is paid.",
        code: "PAYOUT_RECIPIENT_REQUIRES_FINANCE",
      },
      { status: 403 },
    );
  }
  const actor = {
    kind: "member" as const,
    membershipId: access.member.id,
    role: access.member.role,
  };

  if (patch.status === "REMOVED") {
    if (
      patch.role !== undefined ||
      patch.departmentLabel !== undefined ||
      patch.payoutRecipient !== undefined
    ) {
      return NextResponse.json(
        { error: "Remove a member on its own, without other changes." },
        { status: 400 },
      );
    }
    try {
      await removeMember({
        orgId,
        memberId,
        actor,
        actorUserId: access.session.user.id,
        force: new URL(req.url).searchParams.get("force") === "true",
      });
      const membership = await prisma.membership.findFirst({
        where: { id: memberId, organizationId: orgId },
      });
      return NextResponse.json({ membership });
    } catch (err) {
      return errorResponse(err) ?? reportAndRethrow(err);
    }
  }

  let stagedRoleEmail: StagedOnboardingEmail | null = null;

  try {
    const result = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const current = await tx.membership.findFirst({
            where: { id: memberId, organizationId: orgId },
          });
          if (!current) {
            throw Object.assign(new Error("Member not found"), {
              httpStatus: 404,
            });
          }

          assertNotTombstone(current);

          const roleChanged =
            patch.role !== undefined && patch.role !== current.role;
          const statusChanged =
            patch.status !== undefined && patch.status !== current.status;

          const roleEffects = await applyRoleAndStatusTransitions(tx, {
            orgId,
            memberId,
            current,
            patch,
            actor,
            org: access.org,
            roleChanged,
            statusChanged,
          });

          const otherData = memberUpdateData(patch, current.role, roleEffects);
          const updated =
            Object.keys(otherData).length > 0
              ? await tx.membership.update({
                  where: { id: memberId },
                  data: otherData,
                })
              : await tx.membership.findUniqueOrThrow({
                  where: { id: memberId },
                });

          if (roleChanged || statusChanged) {
            await recomputeIndependenceAcross(tx, [current, updated]);
          }

          await auditMemberChange(tx, {
            orgId,
            actorMembershipId: access.member.id,
            current,
            updated,
            patch,
            roleChanged,
            statusChanged,
          });

          await emitMembershipStatusWebhook(tx, {
            orgId,
            memberId,
            statusChanged,
            previousStatus: current.status,
            nextStatus: patch.status,
            userId: updated.userId,
            role: updated.role,
          });

          if (roleChanged) {
            stagedRoleEmail = await stageOrgMembershipChangedEmail(
              {
                userId: current.userId,
                membershipId: memberId,
                kind: "ROLE_CHANGED",
                orgName: access.org.name,
                roleBefore: current.role,
                roleAfter: patch.role,
                actorName:
                  access.session.user.name ??
                  access.session.user.email ??
                  "An operator",
                dashboardUrl: `${getAppUrl()}/dashboard/organization/${orgId}/home`,
              },
              tx,
            );
          }

          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    if (stagedRoleEmail) {
      const staged = stagedRoleEmail;
      scheduleAfter(
        () => attemptOnboardingEmail(staged),
        "member.onboarding-email",
      );
    }

    return NextResponse.json({ membership: result });
  } catch (err) {
    return errorResponse(err) ?? reportAndRethrow(err);
  }
}

export async function DELETE(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; memberId: string }>;
  },
) {
  const { orgId, memberId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "members.manage",
    requireActive: true,
  });
  if (access.error) return access.error;

  try {
    // ORG-07 — the same removal PATCH → REMOVED runs. The guard refuses self
    // removal (a "Leave organization" flow would own that), an OWNER target
    // for a non-OWNER, the last OWNER, and a member who still has upcoming
    // sessions, live seats or money in progress here. #779 §C — only an OWNER
    // may force past the obligations with ?force=true.
    await removeMember({
      orgId,
      memberId,
      actor: { membershipId: access.member.id, role: access.member.role },
      actorUserId: access.session.user.id,
      force: new URL(req.url).searchParams.get("force") === "true",
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err) ?? reportAndRethrow(err);
  }
}
