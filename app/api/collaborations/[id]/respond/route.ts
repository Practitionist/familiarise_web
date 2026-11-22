import { NextRequest, NextResponse } from "next/server";
import {
  collaborationErrorResponse,
  parseBody,
  parseParams,
  unauthorized,
} from "@/lib/api/collaborations/http";
import { getSession } from "@/lib/auth-server";
import {
  CollaborationError,
  respondToInvitation,
} from "@/lib/collaborators/service";
import prisma from "@/lib/prisma";
import {
  collaborationParamsSchema,
  respondToInvitationSchema,
} from "@/schemas/collaborators";

/** The invited expert accepts, naming the terms they saw, or declines. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) return unauthorized();
    const { id } = parseParams(collaborationParamsSchema, await params);
    const body = await parseBody(req, respondToInvitationSchema);
    const profile = await prisma.consultantProfile.findFirst({
      where: { userId: session.user.id, deletedAt: null },
      select: { id: true },
    });
    if (!profile) {
      throw new CollaborationError("NOT_FOUND", "Invitation not found.");
    }
    const data = await respondToInvitation({
      ...body,
      collaboratorId: id,
      consultantProfileId: profile.id,
      userId: session.user.id,
    });
    return NextResponse.json({ data });
  } catch (error) {
    return collaborationErrorResponse(error, "invitation.respond");
  }
}
