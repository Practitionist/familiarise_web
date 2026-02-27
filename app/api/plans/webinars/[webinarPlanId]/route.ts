import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { fetchWebinarPlanDetail } from "@/lib/data/plan-details";
import { apiError } from "@/lib/errors";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string }> },
) {
  try {
    const { webinarPlanId } = await params;
    const webinarPlan = await fetchWebinarPlanDetail(webinarPlanId);

    if (!webinarPlan) {
      return NextResponse.json(
        { error: "Webinar plan not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { data: webinarPlan },
      {
        status: 200,
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    return apiError({ tag: "[WebinarPlan.GET]", error });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { webinarPlanId } = await params;
    const body = await request.json();

    // Input validation
    if (body.durationInHours && body.durationInHours <= 0) {
      return NextResponse.json(
        { error: "Duration must be a positive number" },
        { status: 400 },
      );
    }

    if (body.price && body.price <= 0) {
      return NextResponse.json(
        { error: "Price must be a positive number" },
        { status: 400 },
      );
    }

    if (body.maxParticipants && body.maxParticipants <= 0) {
      return NextResponse.json(
        { error: "Maximum participants must be a positive number" },
        { status: 400 },
      );
    }

    const webinarPlan = await prisma.webinarPlan.update({
      where: {
        id: webinarPlanId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              consultantProfileId:
                session.user.consultantProfileId ?? "__none__",
            }),
      },
      data: {
        title: body.title,
        description: body.description,
        durationInHours: body.durationInHours,
        price: body.price ? Math.round(body.price) : undefined, // Ensure price is an integer
        maxParticipants: body.maxParticipants,
        language: body.language,
        level: body.level,
        prerequisites: body.prerequisites,
        materialProvided: body.materialProvided,
        learningOutcomes: body.learningOutcomes,
        consultantProfile: body.consultantProfileId
          ? {
              connect: { id: body.consultantProfileId },
            }
          : undefined,
        topics: body.topicIds
          ? {
              set: body.topicIds.map((id: string) => ({ id })),
            }
          : undefined,
      },
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
            domain: true,
            subDomains: true,
            tags: true,
          },
        },
        webinars: true,
        topics: true,
      },
    });

    return NextResponse.json({ data: webinarPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Webinar plan not found" },
        { status: 404 },
      );
    }
    return apiError({ tag: "[WebinarPlan.PUT]", error });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { webinarPlanId } = await params;

    // Verify existence + ownership in one query (non-owners get 404, not 403)
    const existingPlan = await prisma.webinarPlan.findUnique({
      where: {
        id: webinarPlanId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              consultantProfileId:
                session.user.consultantProfileId ?? "__none__",
            }),
      },
      select: { id: true },
    });
    if (!existingPlan) {
      return NextResponse.json(
        { error: "Webinar plan not found" },
        { status: 404 },
      );
    }

    // Check if there are any associated webinars
    const associatedWebinars = await prisma.webinar.findMany({
      where: { webinarPlanId: webinarPlanId },
    });

    if (associatedWebinars.length > 0) {
      return NextResponse.json(
        { error: "Cannot delete webinar plan with associated webinars" },
        { status: 400 },
      );
    }

    // Check for active collaborators (PENDING or ACCEPTED)
    const activeCollaborators = await prisma.webinarCollaborator.count({
      where: {
        webinarPlanId,
        status: { in: ["PENDING", "ACCEPTED"] },
      },
    });

    if (activeCollaborators > 0) {
      return NextResponse.json(
        {
          error:
            "Cannot delete webinar plan with active collaborators. Remove or notify collaborators first.",
        },
        { status: 400 },
      );
    }

    const webinarPlan = await prisma.webinarPlan.delete({
      where: { id: webinarPlanId },
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
            domain: true,
            subDomains: true,
            tags: true,
          },
        },
        topics: true,
      },
    });

    return NextResponse.json({ data: webinarPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Webinar plan not found" },
        { status: 404 },
      );
    }
    return apiError({ tag: "[WebinarPlan.DELETE]", error });
  }
}
