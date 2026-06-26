import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma, PlanEmailSupport } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { fetchClassPlanDetail } from "@/lib/data/plan-details";
import { apiError } from "@/lib/errors";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ classPlanId: string }> },
) {
  try {
    const { classPlanId } = await params;
    const classPlan = await fetchClassPlanDetail(classPlanId);

    if (!classPlan) {
      return NextResponse.json(
        { error: "Class plan not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { data: classPlan },
      {
        status: 200,
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "plans" } });
    return apiError({ tag: "[ClassPlan.GET]", error });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ classPlanId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { classPlanId } = await params;
    const body = await request.json();

    // Input validation
    if (body.durationInMonths && body.durationInMonths <= 0) {
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

    if (body.meetingsPerWeek && body.meetingsPerWeek < 0) {
      return NextResponse.json(
        { error: "Meetings per week must be a non-negative number" },
        { status: 400 },
      );
    }

    if (body.maxParticipants && body.maxParticipants <= 0) {
      return NextResponse.json(
        { error: "Maximum participants must be a positive number" },
        { status: 400 },
      );
    }

    if (
      body.emailSupport &&
      !Object.values(PlanEmailSupport).includes(body.emailSupport)
    ) {
      return NextResponse.json(
        { error: "Invalid email support value" },
        { status: 400 },
      );
    }

    const classPlan = await prisma.classPlan.update({
      where: {
        id: classPlanId,
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
        durationInMonths: body.durationInMonths,
        price: body.price,
        meetingsPerWeek: body.meetingsPerWeek,
        emailSupport: body.emailSupport as PlanEmailSupport,
        maxParticipants: body.maxParticipants,
        language: body.language,
        level: body.level,
        prerequisites: body.prerequisites,
        materialProvided: body.materialProvided,
        learningOutcomes: body.learningOutcomes,
        consultantProfile:
          isPrivileged(session.user.role) && body.consultantProfileId
            ? { connect: { id: body.consultantProfileId } }
            : undefined,
        topics: body.topicIds
          ? {
              set: body.topicIds.map((id: string) => ({ id })),
            }
          : undefined,
        classContents: body.classContents
          ? {
              deleteMany: {},
              create: body.classContents.map((content: Prisma.ClassContentCreateWithoutClassPlanInput) => ({
                title: content.title,
                description: content.description,
                contentType: content.contentType,
                contentUrl: content.contentUrl,
                order: content.order,
                hoursAllotted: content.hoursAllotted,
              })),
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
        classes: true,
        topics: true,
        classContents: true,
      },
    });

    return NextResponse.json({ data: classPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Class plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "plans" } });
    return apiError({ tag: "[ClassPlan.PUT]", error });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ classPlanId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { classPlanId } = await params;

    // Verify existence + ownership in one query (non-owners get 404, not 403)
    const existingPlan = await prisma.classPlan.findUnique({
      where: {
        id: classPlanId,
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
        { error: "Class plan not found" },
        { status: 404 },
      );
    }

    // Check if there are any associated classes
    const associatedClasses = await prisma.class.findMany({
      where: { classPlanId: classPlanId },
    });

    if (associatedClasses.length > 0) {
      return NextResponse.json(
        { error: "Cannot delete class plan with associated classes" },
        { status: 400 },
      );
    }

    // Check for active collaborators (PENDING or ACCEPTED)
    const activeCollaborators = await prisma.collaborator.count({
      where: {
        classPlanId,
        status: { in: ["PENDING", "ACCEPTED"] },
      },
    });

    if (activeCollaborators > 0) {
      return NextResponse.json(
        {
          error:
            "Cannot delete class plan with active collaborators. Remove or notify collaborators first.",
        },
        { status: 400 },
      );
    }

    const classPlan = await prisma.classPlan.delete({
      where: { id: classPlanId },
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
        classContents: true,
      },
    });

    return NextResponse.json({ data: classPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Class plan not found" },
        { status: 404 },
      );
    }
    return apiError({ tag: "[ClassPlan.DELETE]", error });
  }
}
