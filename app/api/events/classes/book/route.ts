import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import authOptions from "@/app/api/auth/[...nextauth]/options";

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { classId } = await request.json();

    const consultee = await prisma.consulteeProfile.findUnique({
      where: { userId: session.user.id },
    });

    if (!consultee) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const classData = await prisma.class.findUnique({
      where: { id: classId },
      include: { classPlan: true },
    });

    if (!classData) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }

    // Check if the class has reached its maximum capacity
    const participantCount = await prisma.appointment.count({
      where: { classId: classId },
    });

    if (participantCount >= classData.currentParticipants) {
      // If the class is full, add the user to the waitlist
      await prisma.waitlist.create({
        data: {
          userId: session.user.id,
          class: { connect: { id: classId } },
        },
      });
      return NextResponse.json(
        { message: "Class is full. You have been added to the waitlist." },
        { status: 202 },
      );
    }

    // Create an appointment for the class
    const appointment = await prisma.appointment.create({
      data: {
        appointmentType: "CLASS",
        class: { connect: { id: classId } },
        slotOfAppointment: {
          create: {
            consulteeProfile: { connect: { id: consultee.id } },
            slotStartTimeInUTC: classData.startDate!,
            slotEndTimeInUTC: classData.endDate!,
          },
        },
      },
    });

    // Create a payment record (status will be updated after successful payment)
    const payment = await prisma.payment.create({
      data: {
        amount: classData.classPlan?.price || 0,
        currency: "USD", // Assuming USD, adjust as needed
        paymentStatus: "PENDING",
        paymentMethod: "STRIPE", // Default to Stripe, can be changed later
        paymentGateway: "STRIPE", // Default to Stripe, can be changed later
        paymentIntent: "", // This will be updated after initiating payment
        description: `Payment for Class ID: ${classId}`,
        user: { connect: { id: session.user.id } },
        appointment: { connect: { id: appointment.id } },
      },
    });

    return NextResponse.json({ appointment, payment }, { status: 201 });
  } catch (error) {
    console.error("Error booking class:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
