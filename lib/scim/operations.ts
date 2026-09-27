import { Prisma } from "@prisma/client";
import type { PrismaLike, Tx } from "@/lib/prisma";
/**
 * SCIM 2.0 User operations — `createUser`, `patchUser`, `deprovisionUser`,
 * `listUsers`. Pure functions that read + write through Prisma; the
 * route handlers wrap them with SCIM auth + error envelopes.
 *
 * Why the operations are split out from the route handlers
 * --------------------------------------------------------
 * The same logic powers (1) the standard SCIM endpoints under
 * `/scim/v2/Users`, (2) the per-org dashboard's "manually trigger sync"
 * action (a future addition), and (3) unit tests. Keeping the work
 * here means each call site stays thin.
 *
 * Erasure short-circuit
 * ---------------------
 * Every operation that creates or revives a User refuses to act when
 * `User.erasedAt IS NOT NULL` — once a user has exercised DPDP §12
 * right-to-erasure, SCIM cannot re-create or re-activate them. The
 * SCIM response is `410 Gone` per RFC 7644 §3.6, surfacing as a
 * permanent error in the IdP's provisioning report so the operator
 * can purge the user from their IdP roster.
 */

import {
  applyMembershipRoleEffects,
  bumpUserSessionGeneration,
  recomputeConsultantIsIndependent,
  recomputeIndependenceAcross,
} from "@/lib/api/organizations/membership-transitions";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  DomainVerificationRequiredError,
  UNVERIFIED_ORG_SEAT_CAP,
  hasVerifiedDomain,
} from "@/lib/enterprise/governance";
import { releaseSeatsForTerminatedAssignments } from "@/lib/api/organizations/seat-count";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import {
  MembershipGuardError,
  assertRoleChangeAllowed,
  assertStatusChangeAllowed,
  type GuardedMembership,
  type MembershipActor,
} from "@/lib/enterprise/membership-guards";
import { transitionMembership } from "@/lib/enterprise/transitions";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { resolveRoleFromGroupNames } from "./resource-user";

/**
 * #1846 bucket C — SCIM acts on the group mappings an OWNER configured, so it
 * passes the shared membership guard with OWNER authority. It still obeys the
 * LEARNER↔EXPERT block, the no-history rule, the last-OWNER rule and the
 * status CAS, and it never revives a REMOVED or ERASED row (N3).
 */
const IDP_ACTOR: MembershipActor = { kind: "idp" };

const TOMBSTONES = new Set(["REMOVED", "ERASED"]);

function tombstoneConflict(status: string): ScimOperationError {
  return {
    kind: "CONFLICT",
    detail: `membership is ${status.toLowerCase()} — re-invite via the dashboard instead of re-provisioning`,
  };
}

/** Runs a SCIM write Serializable and turns a guard refusal into a CONFLICT. */
async function guardedScimWrite<T>(
  prisma: PrismaLike,
  fn: (tx: Tx) => Promise<T | ScimOperationError>,
): Promise<T | ScimOperationError> {
  try {
    return await withSerializableRetry(() =>
      prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }),
    );
  } catch (err) {
    if (err instanceof MembershipGuardError) {
      return { kind: "CONFLICT", detail: err.message };
    }
    throw err;
  }
}

/**
 * Moves a membership between ACTIVE and SUSPENDED for the IdP: the guard, the
 * status CAS, the session bump and the isIndependent recompute. A suspension
 * also closes the member's live seats and releases them, as a SCIM
 * deprovision does. Returns whether anything changed.
 */
async function applyScimStatus(
  tx: Tx,
  m: GuardedMembership,
  to: "ACTIVE" | "SUSPENDED",
): Promise<boolean> {
  if (m.status === to) return false;
  await assertStatusChangeAllowed(tx, { membership: m, to, actor: IDP_ACTOR });
  await transitionMembership(tx, {
    where: { id: m.id, organizationId: m.organizationId },
    to,
  });
  if (to === "SUSPENDED") {
    const now = new Date();
    await tx.programAssignment.updateMany({
      where: {
        membershipId: m.id,
        periodEnd: { gte: now },
        status: { in: ["ACTIVE", "PAUSED"] },
      },
      data: { periodEnd: now, status: "CANCELLED" },
    });
    await releaseSeatsForTerminatedAssignments(tx, [m.id], now);
  }
  if (m.role === "EXPERT" && m.consultantProfileId) {
    await recomputeConsultantIsIndependent(tx, m.consultantProfileId);
  }
  // A SCIM-suspended user must not keep an active membership in their cached
  // session (#789).
  await bumpUserSessionGeneration(tx, m.userId);
  return true;
}

export type ScimOperationError =
  | { kind: "USER_ERASED"; userId: string }
  | { kind: "NOT_FOUND" }
  | { kind: "CONFLICT"; detail: string };

export interface CreateScimUserInput {
  organizationId: string;
  userName: string;
  givenName?: string;
  familyName?: string;
  active?: boolean;
  /// SCIM group names from the resource payload; mapped to roles via
  /// `ScimGroupMapping`. Empty array → LEARNER (least-privilege).
  groupNames?: string[];
  /// IdP-assigned external resource id. Stable across SCIM calls;
  /// stored on Membership.externalScimId.
  externalId?: string;
}

export interface ScimUserOpResult {
  membershipId: string;
  userId: string;
  externalScimId: string | null;
  role: string;
  status: string;
}

/**
 * Idempotent upsert by `(organizationId, userName)`.
 *
 * - If no User exists for `userName`, creates one (BetterAuth `User`
 *   row + lazy profile creation handled by `applyMembershipRoleEffects`).
 * - If the User exists but has no Membership in the org, creates one.
 * - If the Membership exists, treats this as a re-provisioning PATCH:
 *   updates active/role/externalScimId in place.
 */
export async function createOrReprovisionScimUser(
  prisma: PrismaLike,
  input: CreateScimUserInput,
): Promise<ScimUserOpResult | ScimOperationError> {
  const {
    organizationId,
    userName,
    givenName,
    familyName,
    active = true,
    groupNames = [],
    externalId,
  } = input;

  const emailLower = userName.trim().toLowerCase();
  if (!emailLower) {
    return { kind: "CONFLICT", detail: "userName is required" };
  }

  // Resolve target role from group mapping BEFORE the transaction so
  // we don't hold the row-level lock open longer than necessary.
  const mappings = await prisma.scimGroupMapping.findMany({
    where: { organizationId },
    select: { scimGroupName: true, role: true },
  });
  const targetRole = resolveRoleFromGroupNames(groupNames, mappings);

  const displayName =
    givenName || familyName
      ? `${givenName ?? ""} ${familyName ?? ""}`.trim()
      : emailLower.split("@")[0];

  // Lookup-then-upsert. Two Prisma calls in a transaction are cheaper
  // than the single `upsert` because we want different audit actions
  // depending on create-vs-reprovision.
  const existingUser = await prisma.user.findUnique({
    where: { email: emailLower },
    select: { id: true, erasedAt: true },
  });
  if (existingUser?.erasedAt) {
    return { kind: "USER_ERASED", userId: existingUser.id };
  }

  // Serializable, matching the invite path (organizations/[orgId]/
  // invitations): the seat-cap gate below is a count-then-create TOCTOU
  // that a parallel IdP provisioning burst could slip past at READ
  // COMMITTED, and the last-OWNER guard needs it too (N4). P2034 is
  // transient and retried instead of surfacing as a SCIM 500 to the IdP.
  return guardedScimWrite(prisma, async (tx) => {
    const user = existingUser
      ? await tx.user.update({
          where: { id: existingUser.id },
          data: {
            // Only refresh the display name when the IdP shipped one —
            // avoid clobbering a user-chosen name with the email prefix.
            ...(givenName || familyName ? { name: displayName } : {}),
          },
        })
      : await tx.user.create({
          data: {
            email: emailLower,
            name: displayName,
            emailVerified: true,
            // SCIM users authenticate via the IdP, not via password. No
            // consent artifact is stamped here: the member's first sign-in
            // shows the DPDP consent step instead (#1846 C3).
          },
        });

    const existingMembership = await tx.membership.findFirst({
      where: { organizationId, userId: user.id },
    });

    if (existingMembership) {
      // Terminal tombstones are admin/compliance-owned — an IdP reprovision
      // heartbeat must not resurrect a REMOVED/ERASED membership (N3).
      if (TOMBSTONES.has(existingMembership.status)) {
        return tombstoneConflict(existingMembership.status);
      }
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { canHost: true, canSponsor: true },
      });
      const roleChanged = existingMembership.role !== targetRole;
      if (roleChanged) {
        await assertRoleChangeAllowed(tx, {
          membership: existingMembership,
          to: targetRole,
          actor: IDP_ACTOR,
          org,
        });
      }
      const statusChanged = await applyScimStatus(
        tx,
        existingMembership,
        active ? "ACTIVE" : "SUSPENDED",
      );
      // The guard already required an expert profile for a move into EXPERT,
      // so the role effects never create one on a reprovision.
      const roleEffects = roleChanged
        ? await applyMembershipRoleEffects(tx, {
            userId: user.id,
            role: targetRole,
          })
        : null;
      const updated = await tx.membership.update({
        where: { id: existingMembership.id },
        data: {
          role: targetRole,
          externalScimId:
            externalId ?? existingMembership.externalScimId ?? null,
          ...(roleEffects && {
            consulteeProfileId: roleEffects.consulteeProfileId,
            consultantProfileId: roleEffects.consultantProfileId,
            payoutRecipient: roleEffects.payoutRecipient,
          }),
        },
      });
      // #789 review — only a real move invalidates the session, so the
      // common idempotent heartbeat pays no sessionGeneration write.
      if (roleChanged) {
        // Both sides: the profile the old EXPERT row held, and the one a move
        // into EXPERT now holds.
        await recomputeIndependenceAcross(tx, [existingMembership, updated]);
        if (!statusChanged) await bumpUserSessionGeneration(tx, user.id);
      }
      await tx.orgAuditLog.create({
        data: {
          organizationId,
          targetMembershipId: updated.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.SCIM_USER_UPDATED,
          description: `SCIM: updated ${emailLower} (role=${targetRole}, active=${active})`,
          details: {
            userName: emailLower,
            from: {
              role: existingMembership.role,
              status: existingMembership.status,
            },
            role: targetRole,
            active,
            groupNames,
          },
        },
      });
      return {
        membershipId: updated.id,
        userId: user.id,
        externalScimId: updated.externalScimId,
        role: updated.role,
        status: updated.status,
      } satisfies ScimUserOpResult;
    }

    // #675 parity with the invite path — an unverified org is hard-capped at
    // UNVERIFIED_ORG_SEAT_CAP seats; SCIM auto-provisioning must honor the same
    // gate or an IdP could bulk-provision straight past it. Only brand-new
    // seats count (reprovisions returned above). Throw (not a CONFLICT return)
    // so the User/profile writes above roll back instead of orphaning.
    if (!(await hasVerifiedDomain(tx, organizationId))) {
      const [activeMembers, pendingInvites] = await Promise.all([
        tx.membership.count({
          where: { organizationId, status: "ACTIVE" },
        }),
        tx.invitation.count({
          where: { organizationId, status: "pending" },
        }),
      ]);
      if (activeMembers + pendingInvites >= UNVERIFIED_ORG_SEAT_CAP) {
        throw new DomainVerificationRequiredError("BULK_SEATS");
      }
    }

    // A new SCIM membership stays automatic (the IdP vouches for the person),
    // so its profile may be created here, as SSO JIT does.
    const roleEffects = await applyMembershipRoleEffects(tx, {
      userId: user.id,
      role: targetRole,
    });
    const created = await tx.membership.create({
      data: {
        organizationId,
        userId: user.id,
        role: targetRole,
        status: active ? "ACTIVE" : "SUSPENDED",
        externalScimId: externalId ?? null,
        consulteeProfileId: roleEffects.consulteeProfileId,
        consultantProfileId: roleEffects.consultantProfileId,
        payoutRecipient: roleEffects.payoutRecipient,
      },
    });
    // #789 review — a newly provisioned membership must show up in the user's
    // session immediately if they already have a live session in another org.
    await bumpUserSessionGeneration(tx, user.id);

    await tx.orgAuditLog.create({
      data: {
        organizationId,
        targetMembershipId: created.id,
        category: "SYSTEM",
        action: AUDIT_ACTIONS.SYSTEM.SCIM_USER_CREATED,
        description: `SCIM: created ${emailLower} as ${targetRole}`,
        details: { userName: emailLower, role: targetRole, active, groupNames },
      },
    });

    // Fan out the standard member.added event — integrators that
    // already subscribe to the in-app invite path get the SCIM path
    // for free, no second subscription.
    await dispatchWebhookEvent({
      prisma: tx,
      organizationId,
      eventType: "member.added",
      payload: {
        membershipId: created.id,
        userId: user.id,
        role: targetRole,
        source: "scim",
      },
    });

    return {
      membershipId: created.id,
      userId: user.id,
      externalScimId: created.externalScimId,
      role: created.role,
      status: created.status,
    } satisfies ScimUserOpResult;
  });
}

/**
 * SCIM PATCH `active` flip (Okta's deactivate, Azure's whole-object replace).
 * It used to be a plain `membership.update`, which revived REMOVED and ERASED
 * rows and skipped the audit row, the session bump, the seat release and the
 * last-OWNER rule (N3). It now goes through the same guard as the dashboard.
 */
export async function setScimUserActive(
  prisma: PrismaLike,
  params: { organizationId: string; resourceId: string; active: boolean },
): Promise<ScimUserOpResult | ScimOperationError> {
  const { organizationId, resourceId, active } = params;
  return guardedScimWrite(prisma, async (tx) => {
    const m = await tx.membership.findFirst({
      where: {
        organizationId,
        OR: [{ externalScimId: resourceId }, { id: resourceId }],
      },
    });
    if (!m) return { kind: "NOT_FOUND" } as const;
    if (TOMBSTONES.has(m.status)) return tombstoneConflict(m.status);

    const changed = await applyScimStatus(
      tx,
      m,
      active ? "ACTIVE" : "SUSPENDED",
    );
    if (changed) {
      await tx.orgAuditLog.create({
        data: {
          organizationId,
          targetMembershipId: m.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.SCIM_USER_UPDATED,
          description: `SCIM: set membership ${m.id} active=${active}`,
          details: { from: m.status, active },
        },
      });
    }
    return {
      membershipId: m.id,
      userId: m.userId,
      externalScimId: m.externalScimId,
      role: m.role,
      status: active ? "ACTIVE" : "SUSPENDED",
    } satisfies ScimUserOpResult;
  });
}

/**
 * SCIM DELETE on a User resource → SUSPEND the membership.
 *
 * Why never erase: DELETE in SCIM means "stop provisioning this
 * resource", not "purge their data". Erasure is the user's own DPDP
 * §12 right, exercised through `/api/users/me/erasure-requests`.
 */
export async function deprovisionScimUser(
  prisma: PrismaLike,
  params: { organizationId: string; resourceId: string },
): Promise<ScimUserOpResult | ScimOperationError> {
  const { organizationId, resourceId } = params;
  // #1846 — the same guarded suspension as SCIM PATCH, so a deprovision can
  // no longer suspend the org's last OWNER. Idempotent: a retry on an
  // already-SUSPENDED row changes nothing, and a REMOVED/ERASED tombstone is
  // never touched (the IdP reads those as inactive either way).
  return guardedScimWrite(prisma, async (tx) => {
    const membership = await tx.membership.findFirst({
      where: {
        organizationId,
        OR: [{ externalScimId: resourceId }, { id: resourceId }],
      },
    });
    if (!membership) return { kind: "NOT_FOUND" } as const;
    const changed =
      !TOMBSTONES.has(membership.status) &&
      (await applyScimStatus(tx, membership, "SUSPENDED"));
    if (changed) {
      await tx.orgAuditLog.create({
        data: {
          organizationId,
          targetMembershipId: membership.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.SCIM_USER_DEPROVISIONED,
          description: `SCIM: deprovisioned membership ${membership.id}`,
          details: { previousStatus: membership.status },
        },
      });
      await dispatchWebhookEvent({
        prisma: tx,
        organizationId,
        eventType: "member.removed",
        payload: {
          membershipId: membership.id,
          userId: membership.userId,
          role: membership.role,
          previousStatus: membership.status,
          source: "scim",
        },
      });
    }
    return {
      membershipId: membership.id,
      userId: membership.userId,
      externalScimId: null,
      role: membership.role,
      status: changed ? "SUSPENDED" : membership.status,
    } satisfies ScimUserOpResult;
  });
}
