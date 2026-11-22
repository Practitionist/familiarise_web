import type { CollaboratorStatus, Prisma } from "@prisma/client";
import { ROLE_INFO } from "@/lib/collaborators/roles";
import { bpsToPercent } from "@/lib/collaborators/rules";
import prisma, { type PrismaLike } from "@/lib/prisma";
import type { PersonLike } from "./person";

export const COLLABORATIONS_PAGE_SIZE = 50;

const PERSON = { id: true, name: true, email: true } as const;
const PLAN = {
  title: true,
  organization: { select: { name: true } },
} as const;

const SELECT = {
  id: true,
  role: true,
  revenueShareBps: true,
  status: true,
  acceptedAt: true,
  endedAt: true,
  webinarPlanId: true,
  classPlanId: true,
  consultantProfileId: true,
  webinarPlan: { select: PLAN },
  classPlan: { select: PLAN },
  consultantProfile: { select: { user: { select: PERSON } } },
  endedBy: { select: PERSON },
} satisfies Prisma.CollaboratorSelect;

/** One collaboration as the back-office list shows it. */
export interface BackofficeCollaboration {
  id: string;
  planType: "webinar" | "class";
  planId: string;
  planTitle: string;
  /** The organisation that owns the plan; null on an expert's own plan. */
  organizationName: string | null;
  expert: PersonLike;
  consultantProfileId: string;
  roleLabel: string;
  sharePercent: number;
  status: CollaboratorStatus;
  acceptedAt: Date | null;
  endedAt: Date | null;
  /** Null when the platform ended it, or it has not ended. */
  endedBy: PersonLike | null;
}

/** One page of every collaboration on the platform, the most recently changed first. */
export async function readCollaborations(
  { page }: { page: number },
  db: Pick<PrismaLike, "collaborator"> = prisma,
): Promise<{ rows: BackofficeCollaboration[]; total: number; page: number }> {
  const [total, found] = await Promise.all([
    db.collaborator.count(),
    db.collaborator.findMany({
      select: SELECT,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * COLLABORATIONS_PAGE_SIZE,
      take: COLLABORATIONS_PAGE_SIZE,
    }),
  ]);
  const rows = found.map((row): BackofficeCollaboration => {
    const plan = row.webinarPlan ?? row.classPlan;
    return {
      id: row.id,
      planType: row.webinarPlanId ? "webinar" : "class",
      planId: row.webinarPlanId ?? row.classPlanId ?? "",
      planTitle: plan?.title ?? "",
      organizationName: plan?.organization?.name ?? null,
      expert: row.consultantProfile.user,
      consultantProfileId: row.consultantProfileId,
      roleLabel: ROLE_INFO[row.role].label,
      sharePercent: bpsToPercent(row.revenueShareBps),
      status: row.status,
      acceptedAt: row.acceptedAt,
      endedAt: row.endedAt,
      endedBy: row.endedBy,
    };
  });
  return { rows, total, page };
}
