import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import {
  getCollaborators,
  inviteCollaborator,
} from "@/lib/collaborators/service";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { webinarPlanId } = await params;
    const collaborators = await getCollaborators("webinar", webinarPlanId);
    return NextResponse.json({ data: collaborators });
  } catch (error) {
    console.error("Error fetching webinar collaborators:", error);
    return NextResponse.json(
      { error: "Failed to fetch collaborators" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { webinarPlanId } = await params;

    // Verify the requester is the plan owner
    const plan = await prisma.webinarPlan.findUnique({
      where: { id: webinarPlanId },
      include: { consultantProfile: true },
    });

    if (!plan?.consultantProfile) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    const ownerProfile = await prisma.consultantProfile.findFirst({
      where: { userId: session.user.id },
    });

    if (plan.consultantProfileId !== ownerProfile?.id) {
      return NextResponse.json(
        { error: "Only the plan owner can invite collaborators" },
        { status: 403 },
      );
    }

    const body = await req.json();
    const { consultantProfileId, role, revenueSharePercentage } = body;

    if (!consultantProfileId || !role || revenueSharePercentage === undefined) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    const collab = await inviteCollaborator(
      "webinar",
      webinarPlanId,
      consultantProfileId,
      role,
      revenueSharePercentage,
      ownerProfile.id,
    );

    if (!collab) {
      return NextResponse.json(
        { error: "Failed to invite. Revenue share may exceed limit (max 90% total for collaborators)." },
        { status: 400 },
      );
    }

    return NextResponse.json({ data: collab });
  } catch (error) {
    console.error("Error inviting webinar collaborator:", error);
    return NextResponse.json(
      { error: "Failed to invite collaborator" },
      { status: 500 },
    );
  }
}
