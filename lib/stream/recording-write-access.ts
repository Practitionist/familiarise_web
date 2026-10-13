import "server-only";

import { hasAnyOrgPermission } from "@/lib/auth/org-permissions";
import prisma from "@/lib/prisma";
import { resolveOperatorRecordingAccess } from "@/lib/stream/recording-operator-access";
import { recordingWriteFacts } from "@/lib/stream/recording-slots";

export type RecordingWriteAccess =
  | { allowed: false }
  | { allowed: true; via: "host" | "operator" }
  | { allowed: true; via: "org"; orgName: string };

/**
 * Rename and delete follow the session-content rule: the session's host or an
 * accepted co-host; an organisation's catalog managers only on a webinar or
 * class plan it owns, never a 1:1; operators through their own grant.
 */
export async function resolveRecordingWriteAccess(
  user: { id: string; role?: string | null },
  recording: { appointmentId: string; sessionHostProfileId: string | null },
): Promise<RecordingWriteAccess> {
  const facts = await recordingWriteFacts(
    recording.appointmentId,
    user.id,
    recording.sessionHostProfileId,
  );
  if (facts.host) return { allowed: true, via: "host" };
  if (facts.groupPlanOrgId) {
    const membership = await prisma.membership.findFirst({
      where: {
        organizationId: facts.groupPlanOrgId,
        userId: user.id,
        status: "ACTIVE",
      },
      select: { role: true, organization: { select: { name: true } } },
    });
    if (
      membership &&
      hasAnyOrgPermission(membership.role, ["catalog.manage"])
    ) {
      return {
        allowed: true,
        via: "org",
        orgName: membership.organization.name,
      };
    }
  }
  if (resolveOperatorRecordingAccess(user.role).canPlay) {
    return { allowed: true, via: "operator" };
  }
  return { allowed: false };
}
