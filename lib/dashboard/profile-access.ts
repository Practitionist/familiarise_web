import { cache } from "react";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import prisma from "@/lib/prisma";

const consultantProfileExists = cache(async (id: string) => {
  const row = await prisma.consultantProfile.findUnique({
    where: { id },
    select: { id: true },
  });
  return row !== null;
});

const consulteeProfileExists = cache(async (id: string) => {
  const row = await prisma.consulteeProfile.findUnique({
    where: { id },
    select: { id: true },
  });
  return row !== null;
});

type Viewer = {
  role: string;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
};

/** False for a missing profile, or for someone else's unless the viewer is an operator. Owners and strangers cost no query. */
export async function viewerMayOpenProfile(
  kind: "consultant" | "consultee",
  profileId: string,
  viewer: Viewer,
): Promise<boolean> {
  const owned =
    kind === "consultant"
      ? viewer.consultantProfileId
      : viewer.consulteeProfileId;
  if (owned === profileId) return true;
  if (!isOperatorRole(viewer.role)) return false;
  return kind === "consultant"
    ? consultantProfileExists(profileId)
    : consulteeProfileExists(profileId);
}
