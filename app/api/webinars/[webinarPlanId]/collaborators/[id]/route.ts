import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import {
  updateCollaborator,
  removeCollaborator,
} from "@/lib/collaborators/service";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string; id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = await req.json();

    const collab = await updateCollaborator("webinar", id, body);
    if (!collab) {
      return NextResponse.json(
        { error: "Failed to update collaborator" },
        { status: 400 },
      );
    }

    return NextResponse.json({ data: collab });
  } catch (error) {
    console.error("Error updating webinar collaborator:", error);
    return NextResponse.json(
      { error: "Failed to update collaborator" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string; id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { webinarPlanId, id } = await params;

    // Verify the requester is the plan owner
    const plan = await prisma.webinarPlan.findUnique({
      where: { id: webinarPlanId },
    });

    const ownerProfile = await prisma.consultantProfile.findFirst({
      where: { userId: session.user.id },
    });

    if (plan?.consultantProfileId !== ownerProfile?.id) {
      return NextResponse.json(
        { error: "Only the plan owner can remove collaborators" },
        { status: 403 },
      );
    }

    const collab = await removeCollaborator("webinar", id);
    if (!collab) {
      return NextResponse.json(
        { error: "Failed to remove collaborator" },
        { status: 400 },
      );
    }

    return NextResponse.json({ data: collab });
  } catch (error) {
    console.error("Error removing webinar collaborator:", error);
    return NextResponse.json(
      { error: "Failed to remove collaborator" },
      { status: 500 },
    );
  }
}
