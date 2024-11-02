import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const consulteeId = searchParams.get("consulteeId");
    const consultantId = searchParams.get("consultantId");

    let classes;

    if (consulteeId) {
      classes = await prisma.class.findMany({
        where: {
          appointment: {
            some: {
              slotOfAppointment: {
                some: {
                  consulteeProfile: {
                    id: consulteeId,
                  },
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
                  consulteeProfile: true,
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
