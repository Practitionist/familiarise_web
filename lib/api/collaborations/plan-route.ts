import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { getPlanTeamForUser } from "@/lib/collaborators/queries";
import { inviteCollaborator } from "@/lib/collaborators/service";
import type { PlanType } from "@/lib/collaborators/team";
import { resolveCollaborationViewer } from "@/lib/collaborators/viewer";
import prisma from "@/lib/prisma";
import { applyRateLimit, collaboratorInviteLimiter } from "@/lib/rate-limit";
import {
  inviteCollaboratorSchemas,
  planParamsSchema,
} from "@/schemas/collaborators";
import {
  collaborationErrorResponse,
  parseBody,
  parseParams,
  requireManager,
  unauthorized,
} from "./http";

type RouteContext = { params: Promise<{ planId: string }> };

/** The list and invite handlers of one plan type; the webinar and class routes differ only in it. */
export function planCollaborationHandlers(planType: PlanType) {
  async function GET(_req: NextRequest, { params }: RouteContext) {
    try {
      const session = await getSession();
      if (!session?.user?.id) return unauthorized();
      const { planId } = parseParams(planParamsSchema, await params);
      const result = await getPlanTeamForUser(
        { planType, planId },
        session.user.id,
      );
      if (result.status === "not_found") {
        return NextResponse.json(
          { error: "Plan not found.", code: "NOT_FOUND" },
          { status: 404 },
        );
      }
      if (result.status === "forbidden") {
        return NextResponse.json(
          { error: "You are not on this plan's team.", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
      const { viewer } = result;
      return NextResponse.json({
        data: result.data,
        viewer: viewer.kind,
        canManage: viewer.kind === "manager" && viewer.canWrite,
      });
    } catch (error) {
      return collaborationErrorResponse(error, `${planType}.team.list`);
    }
  }

  async function POST(req: NextRequest, { params }: RouteContext) {
    try {
      const session = await getSession();
      if (!session?.user?.id) return unauthorized();
      const { planId } = parseParams(planParamsSchema, await params);
      const ref = { planType, planId };
      const access = await resolveCollaborationViewer(
        prisma,
        ref,
        session.user.id,
      );
      requireManager(access);
      const body = await parseBody(req, inviteCollaboratorSchemas[planType]);
      const limited = await applyRateLimit(
        collaboratorInviteLimiter,
        `collab-invite:${session.user.id}`,
      );
      if (limited) return limited;

      const data = await inviteCollaborator({
        ref,
        consultantProfileId: body.consultantProfileId,
        role: body.role,
        sharePercent: body.sharePercent,
        invitedByProfileId: access.callerProfileId,
      });
      return NextResponse.json({ data }, { status: 201 });
    } catch (error) {
      return collaborationErrorResponse(error, `${planType}.team.invite`);
    }
  }

  return { GET, POST };
}
