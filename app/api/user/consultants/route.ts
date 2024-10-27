import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, ScheduleType, UserRole } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import authOptions from "../../auth/[...nextauth]/options";

export async function GET(req: NextRequest) {
  try {
    // const session = await getServerSession(authOptions);
    // if (!session) {
    //   return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // }

    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '10');
    const domain = searchParams.get('domain');

    const skip = (page - 1) * limit;
    const where = domain ? { domain: { name: domain } } : {};

    const [consultants, total] = await Promise.all([
      prisma.consultantProfile.findMany({
        where,
        skip,
        take: limit,
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
          consultationPlans: true,
          subscriptionPlans: true,
          webinarPlans: true,
          classPlans: true,
        },
      }),
      prisma.consultantProfile.count({ where }),
    ]);

    return NextResponse.json({
      data: consultants,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      }
    }, { status: 200 });
  } catch (error) {
    console.error("Error getting consultants:", error);
    return NextResponse.json({ error: "An error occurred while fetching consultants" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();

    // Validate required fields
    const requiredFields = ['userId', 'domainId', 'subDomainIds', 'scheduleType'];
    for (const field of requiredFields) {
      if (!body[field]) {
        return NextResponse.json({ error: `Missing required field: ${field}` }, { status: 400 });
      }
    }

    // Validate scheduleType
    if (!Object.values(ScheduleType).includes(body.scheduleType)) {
      return NextResponse.json({ error: "Invalid scheduleType" }, { status: 400 });
    }

    const newConsultant = await prisma.consultantProfile.create({
      data: {
        rating: 0,
        specialization: body.specialization,
        experience: body.experience,
        description: body.description,
        scheduleType: body.scheduleType,
        user: { connect: { id: body.userId } },
        domain: { connect: { id: body.domainId } },
        subDomains: {
          connect: body.subDomainIds.map((id: string) => ({ id })),
        },
        tags: body.tagIds ? {
          connect: body.tagIds.map((id: string) => ({ id })),
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

    return NextResponse.json({ data: newConsultant }, { status: 201 });
  } catch (error) {
    console.error("Error creating consultant:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return NextResponse.json({ error: "A consultant profile already exists for this user" }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "An error occurred while creating the consultant profile" }, { status: 500 });
  }
}
