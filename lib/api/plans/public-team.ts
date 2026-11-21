import type { ConsultantVerificationStatus } from "@prisma/client";
import type { getSession } from "@/lib/auth-server";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import type { PlanRef } from "@/lib/collaborators/team";
import { resolveCollaborationViewer } from "@/lib/collaborators/viewer";
import { isPublicExpertProfile } from "@/lib/profiles/public-profile";
import prisma from "@/lib/prisma";

type Session = Awaited<ReturnType<typeof getSession>>;

/** A team member's profile as the plan detail reader selects it. */
type TeamProfile = {
  userId: string;
  verificationStatus: ConsultantVerificationStatus;
  deletedAt: Date | null;
  user: { id: string };
};

type TeamRow = { consultantProfile: TeamProfile };

/** A profile as a plan page or its by-id GET sends it: no user ids, no deletion stamp. */
type PublicTeamProfile<P extends TeamProfile> = Omit<
  P,
  "userId" | "deletedAt" | "user"
> & { user: Omit<P["user"], "id"> };

export type PlanTeamMember<R extends TeamRow> = Omit<R, "consultantProfile"> & {
  consultantProfile: PublicTeamProfile<R["consultantProfile"]>;
};

/** Whether the team holds a member whose expert page is not public. */
export const hidesTeamMembers = (rows: readonly TeamRow[]): boolean =>
  rows.some((r) => !isPublicExpertProfile(r.consultantProfile));

/** A plan manager, a member of the plan's team or an operator sees every member. */
async function seesWholeTeam(ref: PlanRef, session: Session): Promise<boolean> {
  const user = session?.user;
  if (!user?.id) return false;
  if (isOperatorRole(user.role)) return true;
  const { viewer } = await resolveCollaborationViewer(prisma, ref, user.id);
  return (
    viewer.kind === "manager" ||
    viewer.kind === "presenter" ||
    viewer.kind === "crew"
  );
}

function withoutUserId<U extends { id: string }>(user: U): Omit<U, "id"> {
  const { id, ...rest } = user;
  return rest;
}

function publicProfile<P extends TeamProfile>(
  profile: P,
): PublicTeamProfile<P> {
  const { userId, deletedAt, user, ...rest } = profile;
  return { ...rest, user: withoutUserId(user) };
}

function toMember<R extends TeamRow>(row: R): PlanTeamMember<R> {
  const { consultantProfile, ...rest } = row;
  return { ...rest, consultantProfile: publicProfile(consultantProfile) };
}

/** The team a plan page lists to this viewer: members with a public expert page, or everyone for the plan's own people. */
export async function planTeamForViewer<R extends TeamRow>(
  rows: readonly R[],
  ref: PlanRef,
  session: Session,
): Promise<PlanTeamMember<R>[]> {
  const whole = hidesTeamMembers(rows) && (await seesWholeTeam(ref, session));
  return rows
    .filter((r) => whole || isPublicExpertProfile(r.consultantProfile))
    .map(toMember);
}
