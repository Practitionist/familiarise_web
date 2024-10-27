import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { ScheduleType, UserRole } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import authOptions from "../../../auth/[...nextauth]/options";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // const session = await getServerSession(authOptions);
    // if (!session) {
    //   return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // }

    const consultant = await prisma.consultantProfile.findUnique({
      where: { id: params.id },
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
        slotsOfAvailabilityCustom: true,
        slotsOfAvailabilityWeekly: true,
        consultationPlans: true,
        subscriptionPlans: true,
        webinarPlans: true,
        classPlans: true,
      },
    });

    if (!consultant) {
      return NextResponse.json({ error: "Consultant not found" }, { status: 404 });
    }

    return NextResponse.json( {data: consultant} , { status: 200 });
  } catch (error) {
    console.error("Error fetching consultant:", error);
    return NextResponse.json({ error: "An error occurred while fetching the consultant" }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || (session.user.id !== params.id && session.user.role !== UserRole.ADMIN)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();

    if (body.scheduleType && !Object.values(ScheduleType).includes(body.scheduleType)) {
      return NextResponse.json({ error: "Invalid scheduleType" }, { status: 400 });
    }

    if (body.domainId && (!body.subDomainIds || !Array.isArray(body.subDomainIds) || body.subDomainIds.length === 0)) {
      return NextResponse.json({ error: "When updating domain, subDomains must also be provided" }, { status: 400 });
    }

    const consultant = await prisma.consultantProfile.update({
      where: { id: params.id },
      data: {
        scheduleType: body.scheduleType as ScheduleType,
        description: body.description,
        qualifications: body.qualifications,
        specialization: body.specialization,
        experience: body.experience,
        domain: body.domainId ? { connect: { id: body.domainId } } : undefined,
        subDomains: body.subDomainIds ? {
          set: body.subDomainIds.map((id: string) => ({ id })),
        } : undefined,
        tags: body.tagIds ? {
          set: body.tagIds.map((id: string) => ({ id })),
        } : undefined,
      },
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
    });

    return NextResponse.json({ data: consultant }, { status: 200 });
  } catch (error) {
    console.error("Error updating consultant:", error);
    return NextResponse.json({ error: "An error occurred while updating the consultant" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check for associated data
    const associatedData = await prisma.consultantProfile.findUnique({
      where: { id: params.id },
      select: {
        _count: {
          select: {
            reviews: true,
            slotsOfAvailabilityWeekly: true,
            slotsOfAvailabilityCustom: true,
            consultationPlans: true,
            subscriptionPlans: true,
            webinarPlans: true,
            classPlans: true,
          },
        },
      },
    });

    if (associatedData && Object.values(associatedData._count).some(count => count > 0)) {
      return NextResponse.json({ error: "Cannot delete consultant profile with associated data" }, { status: 400 });
    }

    const consultant = await prisma.consultantProfile.delete({
      where: { id: params.id },
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
    });

    return NextResponse.json({ data: consultant, message: "Consultant profile deleted successfully" }, { status: 200 });
  } catch (error) {
    console.error("Error deleting consultant:", error);
    return NextResponse.json({ error: "An error occurred while deleting the consultant" }, { status: 500 });
  }
}
