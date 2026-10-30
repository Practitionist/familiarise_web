import type { Prisma } from "@prisma/client";

import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import type { Tx } from "@/lib/prisma";

/**
 * A related-party booking: org money paid for a session delivered by one of
 * that org's own OWNERs. Allowed (open network), but flagged in the org audit
 * log and on the org's appointment list so finance can see it.
 */
export const RELATED_PARTY_ROLE = "OWNER" as const;

type PlanKind = "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";

/** Who is paid for the plan: its owner and, for events, ACCEPTED co-hosts. */
async function planPayeeUserIds(
  tx: Tx,
  kind: PlanKind,
  planId: string,
): Promise<string[]> {
  const owner = { consultantProfile: { select: { userId: true } } } as const;
  const coHosts = {
    collaborators: {
      where: { status: "ACCEPTED" as const },
      select: { consultantProfile: { select: { userId: true } } },
    },
  } as const;
  const where = { id: planId };
  const plan =
    kind === "CONSULTATION"
      ? await tx.consultationPlan.findUnique({ where, select: owner })
      : kind === "SUBSCRIPTION"
        ? await tx.subscriptionPlan.findUnique({ where, select: owner })
        : kind === "WEBINAR"
          ? await tx.webinarPlan.findUnique({
              where,
              select: { ...owner, ...coHosts },
            })
          : await tx.classPlan.findUnique({
              where,
              select: { ...owner, ...coHosts },
            });
  if (!plan) return [];
  const ids = [
    plan.consultantProfile?.userId,
    ...("collaborators" in plan
      ? plan.collaborators.map((c) => c.consultantProfile.userId)
      : []),
  ];
  return ids.filter((id): id is string => !!id);
}

/** Inside the org-funded checkout tx: one audit row when a payee (owner or co-host) owns the paying org. */
export async function recordRelatedPartyBooking(
  tx: Tx,
  input: {
    organizationId: string;
    planKind: PlanKind;
    planId: string;
    paymentId: string;
    appointmentId: string | null;
    buyerMembershipId: string | null;
  },
): Promise<void> {
  const payees = await planPayeeUserIds(tx, input.planKind, input.planId);
  if (payees.length === 0) return;
  const owner = await tx.membership.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: { in: payees },
      role: RELATED_PARTY_ROLE,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  if (!owner) return;
  const details: Prisma.InputJsonObject = {
    relatedParty: true,
    paymentId: input.paymentId,
    appointmentId: input.appointmentId,
    expertMembershipId: owner.id,
  };
  await tx.orgAuditLog.create({
    data: {
      organizationId: input.organizationId,
      actorMembershipId: input.buyerMembershipId,
      targetMembershipId: owner.id,
      category: "PROGRAM",
      action: AUDIT_ACTIONS.PROGRAM.RELATED_PARTY_BOOKING,
      description:
        "Organisation funds paid for a session with one of its owners",
      details,
    },
  });
}

/** The org's active OWNERs, for flagging related-party rows on org lists. */
export async function readOrgOwnerUserIds(
  db: Pick<Tx, "membership">,
  organizationId: string,
): Promise<Set<string>> {
  const owners = await db.membership.findMany({
    where: { organizationId, role: RELATED_PARTY_ROLE, status: "ACTIVE" },
    select: { userId: true },
  });
  return new Set(owners.map((o) => o.userId));
}
