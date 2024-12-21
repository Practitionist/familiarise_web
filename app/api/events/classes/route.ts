import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId"); // Changed from consulteeId
    const consultantId = searchParams.get("consultantId");

    let classes;

    if (userId) {
      // Changed from consulteeId
      classes = await prisma.class.findMany({
        where: {
          appointment: {
            some: {
              slotOfAppointment: {
                some: {
                  userId, // Changed from consulteeProfile.id
                },
              },
            },
          },
        },
        include: {
          classPlan: true,
          appointment: {
            include: {
              slotOfAppointment: {
                include: {
                  user: true, // Changed from consulteeProfile
                },
              },
            },
          },
        },
      });
    } else if (consultantId) {
      classes = await prisma.class.findMany({
        where: {
          classPlan: {
            consultantProfile: {
              id: consultantId,
            },
          },
        },
        include: {
          classPlan: {
            include: {
              consultantProfile: true,
            },
          },
          appointment: true,
        },
      });
      console.log("classes", classes);
    } else {
      classes = await prisma.class.findMany({
        include: {
          classPlan: true,
          appointment: true,
        },
      });
    }

    return NextResponse.json({ data: classes }, { status: 200 });
  } catch (error) {
    console.error("Error fetching classes:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching classes" },
      { status: 500 },
    );
  }
}
