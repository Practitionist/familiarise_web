import { cache } from "react";
import type { UserRole } from "@prisma/client";
import prisma from "@/lib/prisma";

const consultantProfileOwner = cache(async (id: string) => {
  const row = await prisma.consultantProfile.findUnique({
    where: { id },
    select: { userId: true },
  });
  return row?.userId ?? null;
});

const consulteeProfileOwner = cache(async (id: string) => {
  const row = await prisma.consulteeProfile.findUnique({
    where: { id },
    select: { userId: true },
  });
  return row?.userId ?? null;
});

type Viewer = { id: string; role: UserRole };

/** False when the profile is missing, or belongs to someone else and the viewer is not an operator. */
export async function viewerMayOpenProfile(
  kind: "consultant" | "consultee",
  profileId: string,
  viewer: Viewer,
): Promise<boolean> {
  const ownerId = await (kind === "consultant"
    ? consultantProfileOwner(profileId)
    : consulteeProfileOwner(profileId));
  if (!ownerId) return false;
  return (
    ownerId === viewer.id || viewer.role === "ADMIN" || viewer.role === "STAFF"
  );
}
