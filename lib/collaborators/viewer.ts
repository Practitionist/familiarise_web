import type { Prisma } from "@prisma/client";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { isActiveOrgExpert } from "@/lib/enterprise/membership-guards";
import type { PrismaLike } from "@/lib/prisma";
import { inviteExpiresAt } from "./rules";
import { planWhere, type PlanRef } from "./team";

/**
 * Who the caller is to a plan's collaborations. A manager is the plan's own
 * expert or an operator of its organisation; `canWrite` is false while that
 * organisation is not active. The other kinds hold one live row on the plan.
 */
export type CollaborationViewer =
  | { kind: "manager"; via: "owner" | "org"; canWrite: boolean }
  | { kind: "presenter" | "crew" | "invitee"; collaboratorId: string }
  | { kind: "none" };

export type CollaborationPlan = {
  ownerProfileId: string | null;
  organizationId: string | null;
  archivedAt: Date | null;
};

export type CollaborationAccess = {
  plan: CollaborationPlan | null;
  viewer: CollaborationViewer;
  callerProfileId: string | null;
};

const PLAN_SELECT = {
  consultantProfileId: true,
  organizationId: true,
  archivedAt: true,
  organization: { select: { status: true } },
} as const;

function findPlan(db: PrismaLike, ref: PlanRef) {
  return ref.planType === "webinar"
    ? db.webinarPlan.findUnique({
        where: { id: ref.planId },
        select: PLAN_SELECT,
      })
    : db.classPlan.findUnique({
        where: { id: ref.planId },
        select: PLAN_SELECT,
      });
}

/** The one place that decides what a signed-in user may see and do on a plan's team. */
export async function resolveCollaborationViewer(
  db: PrismaLike,
  ref: PlanRef,
  userId: string,
): Promise<CollaborationAccess> {
  const [row, profile] = await Promise.all([
    findPlan(db, ref),
    db.consultantProfile.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    }),
  ]);
  const callerProfileId = profile?.id ?? null;
  if (!row) return { plan: null, viewer: { kind: "none" }, callerProfileId };

  const plan: CollaborationPlan = {
    ownerProfileId: row.consultantProfileId,
    organizationId: row.organizationId,
    archivedAt: row.archivedAt,
  };
  const orgStatus = row.organization?.status ?? null;
  const orgReadable = !row.organizationId || orgStatus !== "DEACTIVATED";
  const canWrite = !row.organizationId || orgStatus === "ACTIVE";

  if (orgReadable) {
    const ownsPlan =
      callerProfileId !== null &&
      row.consultantProfileId === callerProfileId &&
      (!row.organizationId ||
        (await isActiveOrgExpert(db, row.organizationId, callerProfileId)));
    if (ownsPlan) {
      return {
        plan,
        viewer: { kind: "manager", via: "owner", canWrite },
        callerProfileId,
      };
    }
    if (row.organizationId) {
      const membership = await db.membership.findUnique({
        where: {
          userId_organizationId: {
            userId,
            organizationId: row.organizationId,
          },
        },
        select: { status: true, role: true },
      });
      if (
        membership?.status === "ACTIVE" &&
        hasOrgPermission(membership.role, "catalog.manage")
      ) {
        return {
          plan,
          viewer: { kind: "manager", via: "org", canWrite },
          callerProfileId,
        };
      }
    }
  }

  if (callerProfileId) {
    const own = await db.collaborator.findFirst({
      where: {
        ...planWhere(ref),
        consultantProfileId: callerProfileId,
        status: { in: ["PENDING", "ACCEPTED"] },
      },
      select: { id: true, status: true, tier: true },
    });
    if (own) {
      const kind =
        own.status === "PENDING"
          ? "invitee"
          : own.tier === "PRESENTER"
            ? "presenter"
            : "crew";
      return {
        plan,
        viewer: { kind, collaboratorId: own.id },
        callerProfileId,
      };
    }
  }
  return { plan, viewer: { kind: "none" }, callerProfileId };
}

/** The columns every collaborator projection is built from. */
export const COLLABORATOR_VIEW_SELECT = {
  id: true,
  role: true,
  tier: true,
  status: true,
  revenueShareBps: true,
  createdAt: true,
  updatedAt: true,
  acceptedAt: true,
  consultantProfile: {
    select: {
      id: true,
      userId: true,
      user: { select: { name: true, image: true } },
    },
  },
} satisfies Prisma.CollaboratorSelect;

export type CollaboratorViewRow = Prisma.CollaboratorGetPayload<{
  select: typeof COLLABORATOR_VIEW_SELECT;
}>;

/** A collaborator as a screen shows them. `revenueShareBps` is null when the viewer may not see it. */
export type CollaboratorView = Omit<
  CollaboratorViewRow,
  "revenueShareBps" | "updatedAt"
> & {
  revenueShareBps: number | null;
  /** When a pending invitation lapses; null once it is accepted. */
  expiresAt: Date | null;
};

function toView(
  row: CollaboratorViewRow,
  showShare: boolean,
): CollaboratorView {
  const { updatedAt, revenueShareBps, ...rest } = row;
  return {
    ...rest,
    revenueShareBps: showShare ? revenueShareBps : null,
    expiresAt: row.status === "PENDING" ? inviteExpiresAt(updatedAt) : null,
  };
}

/** A manager sees every live row and every share. */
export const toManagerView = (row: CollaboratorViewRow): CollaboratorView =>
  toView(row, true);

/** A collaborator sees their own share; a peer's is withheld, not shown as zero. */
export const toTeamView = (
  row: CollaboratorViewRow,
  ownCollaboratorId: string,
): CollaboratorView => toView(row, row.id === ownCollaboratorId);

/**
 * The live rows of one plan as this viewer may see them: a manager all of
 * them, a collaborator or invitee their own row and the accepted team.
 */
export function projectTeamForViewer(
  rows: readonly CollaboratorViewRow[],
  viewer: CollaborationViewer,
): CollaboratorView[] {
  if (viewer.kind === "none") return [];
  if (viewer.kind === "manager") return rows.map(toManagerView);
  return rows
    .filter((r) => r.status === "ACCEPTED" || r.id === viewer.collaboratorId)
    .map((r) => toTeamView(r, viewer.collaboratorId));
}
