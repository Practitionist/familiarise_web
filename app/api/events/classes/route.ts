import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const consulteeId = searchParams.get('consulteeId');
    const consultantId = searchParams.get('consultantId');

    let classes;

    if (consulteeId) {
      classes = await prisma.class.findMany({
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
      classes = await prisma.class.findMany({
        where: {
          classPlans: {
            consultantProfileId: consultantId
          }
        }
      });
    } else {
      classes = await prisma.class.findMany({});
    }

    return NextResponse.json({ data: classes }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}