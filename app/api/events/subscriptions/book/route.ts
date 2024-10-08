import { NextResponse } from 'next/server';
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import authOptions from '@/app/api/auth/[...nextauth]/options';

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { subscriptionPlanId, tentativeStartDate, tentativeSchedule, requestNotes } = await request.json();

    const consultee = await prisma.consulteeProfile.findUnique({
      where: { userId: session.user.id },
    });

    if (!consultee) {
      return NextResponse.json({ error: 'Consultee profile not found' }, { status: 404 });
    }

    const subscriptionPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: { consultantProfile: true },
    });

    if (!subscriptionPlan) {
      return NextResponse.json({ error: 'Subscription plan not found' }, { status: 404 });
    }

    const endDate = new Date(tentativeStartDate);
    endDate.setMonth(endDate.getMonth() + subscriptionPlan.durationInMonths);

    const subscription = await prisma.subscription.create({
      data: {
        plan: { connect: { id: subscriptionPlanId } },
        requestedBy: { connect: { id: consultee.id } },
        startDate: new Date(tentativeStartDate),
        endDate: endDate,
        tentativeStartDate: new Date(tentativeStartDate),
        tentativeSchedule,
        requestNotes,
        appointmentRequestStatus: 'PENDING',
      },
    });

    // We don't create appointments here as they will be created by the consultant upon approval

    return NextResponse.json({ subscription }, { status: 201 });
  } catch (error) {
    console.error('Error booking subscription:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}