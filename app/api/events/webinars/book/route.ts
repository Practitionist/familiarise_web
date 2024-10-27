import { NextResponse } from 'next/server';
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import authOptions from "@/app/api/auth/[...nextauth]/options";

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { webinarId } = await request.json();

    const consultee = await prisma.consulteeProfile.findUnique({
      where: { userId: session.user.id },
    });

    if (!consultee) {
      return NextResponse.json({ error: 'Consultee profile not found' }, { status: 404 });
    }

    const webinar = await prisma.webinar.findUnique({
      where: { id: webinarId },
      include: { webinarPlan: true },
    });

    if (!webinar) {
      return NextResponse.json({ error: 'Webinar not found' }, { status: 404 });
    }

    // Check if the webinar has reached its maximum capacity
    const participantCount = await prisma.appointment.count({
      where: { webinarId: webinarId },
    });

    if (participantCount >= webinar.webinarPlan.maxParticipants) {
      // If the webinar is full, add the user to the waitlist
      const waitlistEntry = await prisma.waitlist.create({
        data: {
          userId: session.user.id,
          webinar: { connect: { id: webinarId } },
        },
      });
      return NextResponse.json({ message: 'Webinar is full. You have been added to the waitlist.', waitlistEntry }, { status: 202 });
    }

    // Create an appointment for the webinar
    const appointment = await prisma.appointment.create({
      data: {
        appointmentType: 'WEBINAR',
        webinar: { connect: { id: webinarId } },
        slotOfAppointment: {
          create: {
            consulteeProfile: { connect: { id: consultee.id } },
            slotStartTimeInUTC: webinar.scheduledAt,
            slotEndTimeInUTC: webinar.endAt,
          },
        },
      },
      include: {
        slotOfAppointment: true,
      },
    });

    // Create a payment record (status will be updated after successful payment)
    const payment = await prisma.payment.create({
      data: {
        amount: webinar.webinarPlan.price,
        currency: 'USD', // Assuming USD, adjust as needed
        paymentStatus: 'PENDING',
        paymentMethod: 'STRIPE', // Default to Stripe, can be changed later
        paymentGateway: 'STRIPE', // Default to Stripe, can be changed later
        paymentIntent: '', // This will be updated after initiating payment
        description: `Payment for Webinar: ${webinar.webinarPlan.title}`,
        user: { connect: { id: session.user.id } },
        appointment: { connect: { id: appointment.id } },
      },
    });

    return NextResponse.json({ appointment, payment }, { status: 201 });
  } catch (error) {
    console.error('Error booking webinar:', error);
    return NextResponse.json({ error: 'An error occurred while booking the webinar' }, { status: 500 });
  }
}
