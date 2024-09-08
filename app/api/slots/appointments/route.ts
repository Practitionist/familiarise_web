
import { NextResponse } from 'next/server';
import prisma
 from '@/lib/prisma';
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');
  const consultantProfileId = searchParams.get('consultantProfileId');
  const consulteeProfileId = searchParams.get('consulteeProfileId');

  try {
    switch (type) {
      case 'consultations':
        return NextResponse.json(await getConsultations(consultantProfileId, consulteeProfileId));
      case 'subscriptions':
        return NextResponse.json(await getSubscriptions(consultantProfileId, consulteeProfileId));
      case 'classes':
        return NextResponse.json(await getClasses(consultantProfileId, consulteeProfileId));
      case 'webinars':
        return NextResponse.json(await getWebinars(consultantProfileId, consulteeProfileId));
      default:
        return NextResponse.json({ error: 'Invalid appointment type' }, { status: 400 });
    }
  } catch (error) {
    console.error('Error fetching appointments:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

async function getConsultations(consultantProfileId?: string | null, consulteeProfileId?: string | null) {
  return await prisma.consultation.findMany({
    where: {
      consultationPlan: consultantProfileId ? { consultantProfileId } : undefined,
      slotOfAppointment: consulteeProfileId ? { consulteeProfileId } : undefined,
    },
    include: {
      consultationPlan: true,
      slotOfAppointment: {
        include: {
          slotOfAppointmentRequest: true,
          consulteeProfile: true,
        },
      },
      Payment: true,
    },
  });
}

async function getSubscriptions(consultantProfileId?: string | null, consulteeProfileId?: string | null) {
  return await prisma.subscription.findMany({
    where: {
      plan: consultantProfileId ? { consultantProfileId } : undefined,
      slotOfAppointment: consulteeProfileId ? { consulteeProfileId } : undefined,
    },
    include: {
      plan: true,
      slotOfAppointment: {
        include: {
          slotOfAppointmentRequest: true,
          consulteeProfile: true,
        },
      },
      Payment: true,
    },
  });
}

async function getClasses(consultantProfileId?: string | null, consulteeProfileId?: string | null) {
  return await prisma.class.findMany({
    where: {
      classPlans: consultantProfileId ? { consultantProfileId } : undefined,
      slotOfAppointment: consulteeProfileId ? { 
        some: { consulteeProfileId } 
      } : undefined,
    },
    include: {
      classPlans: true,
      topic: true,
      slotOfAppointment: {
        include: {
          slotOfAppointmentRequest: true,
          consulteeProfile: true,
        },
      },
      Payment: true,
    },
  });
}

async function getWebinars(consultantProfileId?: string | null, consulteeProfileId?: string | null) {
  return await prisma.webinar.findMany({
    where: {
      webinarPlan: consultantProfileId ? { consultantProfileId } : undefined,
      slotOfAppointment: consulteeProfileId ? { 
        some: { consulteeProfileId } 
      } : undefined,
    },
    include: {
      webinarPlan: true,
      topic: true,
      slotOfAppointment: {
        include: {
          slotOfAppointmentRequest: true,
          consulteeProfile: true,
        },
      },
      Payment: true,
    },
  });
}