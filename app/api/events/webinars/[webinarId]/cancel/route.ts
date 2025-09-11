import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> }
) {
  try {
    const { webinarId } = await params;

    const result = await prisma.$transaction(async (tx) => {
      const webinar = await tx.webinar.findUnique({ where: { id: webinarId } });
      if (!webinar) throw new Error("Webinar not found");

      // Mark any slots as tentative (non-blocking) and cancel webinar
      await tx.slotOfAppointment.updateMany({
        where: { appointment: { webinarId } },
        data: { isTentative: true },
      });

      const updated = await tx.webinar.update({
        where: { id: webinarId },
        data: { status: "CANCELLED" },
      });

      return updated;
    });

    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof Error) {
      console.error("Webinar cancel error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to cancel webinar" },
      { status: 500 }
    );
  }
}

