import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await params;
    const classData = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true,
              },
            },
            topics: true,
            classContents: {
              orderBy: {
                order: "asc",
              },
            },
          },
        },
        appointments: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true, // Changed from consulteeProfile to user
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: classData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { classId } = await params;
    const body = await request.json();

    // Only the owning consultant or ADMIN/STAFF can update a class instance
    const classData = await prisma.class.update({
      where: {
        id: classId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              classPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      data: {
        schedulingPeriodStartsAt: body.schedulingPeriodStartsAt,
        schedulingPeriodEndsAt: body.schedulingPeriodEndsAt,
        status: body.status,
        recordingUrls: body.recordingUrls,
        feedbackSummary: body.feedbackSummary,
      },
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true,
              },
            },
            topics: true,
            classContents: {
              orderBy: {
                order: "asc",
              },
            },
          },
        },
        appointments: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true, // Changed from consulteeProfile to user
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: classData }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { classId } = await params;

    // Only the owning consultant or ADMIN/STAFF can delete a class instance
    const classData = await prisma.class.delete({
      where: {
        id: classId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              classPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true,
              },
            },
            topics: true,
            classContents: {
              orderBy: {
                order: "asc",
              },
            },
          },
        },
        appointments: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true, // Changed from consulteeProfile to user
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: classData }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
