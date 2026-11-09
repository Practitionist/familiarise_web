import type { Prisma } from "@prisma/client";

/** A collaborator row whose webinar or class plan is not archived: the rows the Collaborations page lists. */
export const LIVE_WEBINAR_COLLABORATOR = {
  collaboratorType: "WEBINAR",
  webinarPlan: { archivedAt: null },
} satisfies Prisma.CollaboratorWhereInput;

export const LIVE_CLASS_COLLABORATOR = {
  collaboratorType: "CLASS",
  classPlan: { archivedAt: null },
} satisfies Prisma.CollaboratorWhereInput;
