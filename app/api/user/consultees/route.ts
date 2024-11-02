import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  try {
    const consultees = await prisma.consulteeProfile.findMany({
      include: {
        slotsOfAppointment: true,
        consultantReviews: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    });

    return NextResponse.json(consultees, { status: 200 });
  } catch (error) {
    console.error("Error getting consultees:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
