import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const consulteeId = searchParams.get('consulteeId');
    const consultantId = searchParams.get('consultantId');

    let webinars;

    if (consulteeId) {
      webinars = await prisma.webinar.findMany({
        where: {
          appointment: {
            some: {
              slotOfAppointment: {
                consulteeProfile: {
                  id: consulteeId
                }
              }
            }
          }
        }
      });
    } else if (consultantId) {
      webinars = await prisma.webinar.findMany({
        where: {
          webinarPlan: {
            consultantProfileId: consultantId
          }
        }
      });
    } else {
      webinars = await prisma.webinar.findMany({});
    }

    return NextResponse.json({ data: webinars }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

// ... existing POST function ...