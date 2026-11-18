import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import {
  CollaborationError,
  leaveCollaboration,
  removeCollaborator,
  updatePendingTerms,
} from "@/lib/collaborators/service";
import { planWhere, type PlanType } from "@/lib/collaborators/team";
import { resolveCollaborationViewer } from "@/lib/collaborators/viewer";
import prisma from "@/lib/prisma";
import {
  memberParamsSchema,
  updatePendingTermsSchemas,
} from "@/schemas/collaborators";
import {
  collaborationErrorResponse,
  parseBody,
  parseParams,
  requireManager,
  unauthorized,
} from "./http";

type RouteContext = { params: Promise<{ planId: string; id: string }> };

/** A manager changes a pending invitation's terms. */
export async function patchCollaborator(
  planType: PlanType,
  req: NextRequest,
  { params }: RouteContext,
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) return unauthorized();
    const { planId, id } = parseParams(memberParamsSchema, await params);
    const ref = { planType, planId };
    requireManager(
      await resolveCollaborationViewer(prisma, ref, session.user.id),
    );
    const body = await parseBody(req, updatePendingTermsSchemas[planType]);
    const data = await updatePendingTerms({ ref, collaboratorId: id, ...body });
    return NextResponse.json({ data });
  } catch (error) {
    return collaborationErrorResponse(error, `${planType}.team.updateTerms`);
  }
}

/** A manager removes any row on the plan; a collaborator ends only their own, and hears when it has already ended. */
export async function deleteCollaborator(
  planType: PlanType,
  _req: NextRequest,
  { params }: RouteContext,
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) return unauthorized();
    const userId = session.user.id;
    const { planId, id } = parseParams(memberParamsSchema, await params);
    const ref = { planType, planId };
    const access = await resolveCollaborationViewer(prisma, ref, userId);
    if (!access.plan) {
      throw new CollaborationError("NOT_FOUND", "Plan not found.");
    }

    if (access.viewer.kind === "manager") {
      requireManager(access);
      const data = await removeCollaborator({
        ref,
        collaboratorId: id,
        removedByUserId: userId,
      });
      return NextResponse.json({ data });
    }
    if (
      !access.callerProfileId ||
      access.viewer.kind === "none" ||
      access.viewer.collaboratorId !== id
    ) {
      // Only the caller's own ended row says so; any other id gets the refusal below.
      const ownEnded =
        access.callerProfileId &&
        (await prisma.collaborator.findFirst({
          where: {
            ...planWhere(ref),
            id,
            consultantProfileId: access.callerProfileId,
            status: { notIn: ["PENDING", "ACCEPTED"] },
          },
          select: { id: true },
        }));
      if (ownEnded) {
        throw new CollaborationError(
          "NOT_FOUND",
          "This collaboration has already ended.",
        );
      }
      throw new CollaborationError(
        "FORBIDDEN",
        "Only the plan's host or the collaborator can end this collaboration.",
      );
    }
    const data = await leaveCollaboration({
      ref,
      collaboratorId: id,
      consultantProfileId: access.callerProfileId,
      userId,
    });
    return NextResponse.json({ data });
  } catch (error) {
    return collaborationErrorResponse(error, `${planType}.team.end`);
  }
}
