import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import {
  getMyCollaborations,
  getHostedCollaborations,
} from "@/lib/collaborators/service";

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const consultantProfile = await prisma.consultantProfile.findFirst({
      where: { userId: session.user.id },
    });

    if (!consultantProfile) {
      return NextResponse.json({
        data: {
          webinarCollaborations: [],
          classCollaborations: [],
          hostedWebinarPlans: [],
          hostedClassPlans: [],
        },
      });
    }

    const [collaborations, hosted] = await Promise.all([
      getMyCollaborations(consultantProfile.id),
      getHostedCollaborations(consultantProfile.id),
    ]);

    return NextResponse.json({
      data: {
        ...collaborations,
        hostedWebinarPlans: hosted.webinarPlans,
        hostedClassPlans: hosted.classPlans,
        hostUser: {
          name: session.user.name ?? null,
          image: session.user.image ?? null,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching collaborations:", error);
    return NextResponse.json(
      { error: "Failed to fetch collaborations" },
      { status: 500 },
    );
  }
}
