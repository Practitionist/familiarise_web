import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { AppointmentsType } from '@prisma/client';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  
  const type = searchParams.get('type')?.toUpperCase();
  const consultantProfileId = searchParams.get('consultantProfileId');
  const consulteeProfileId = searchParams.get('consulteeProfileId');

  if (type && !Object.values(AppointmentsType).includes(type as AppointmentsType)) {
    return NextResponse.json({ error: 'Invalid appointment type' }, { status: 400 });
  }

  try {
    const appointments = await getAppointments(type as AppointmentsType | undefined, consultantProfileId, consulteeProfileId);
    return NextResponse.json(appointments);
  } catch (error) {
    console.error('Error fetching appointments:', error);
    return NextResponse.json({ error: 'An error occurred while fetching appointments' }, { status: 500 });
  }
}

async function getAppointments(type?: AppointmentsType, consultantProfileId?: string | null, consulteeProfileId?: string | null) {
  const whereClause: any = {};

  if (type) {
    whereClause.appointmentType = type;
  }

  if (consultantProfileId) {
    switch (type) {
      case AppointmentsType.CONSULTATION:
        whereClause.consultation = {
          consultationPlan: {
            consultantProfileId
          }
        };
        break;
      case AppointmentsType.SUBSCRIPTION:
        whereClause.subscription = {
          plan: {
            consultantProfileId
          }
        };
        break;
      case AppointmentsType.WEBINAR:
        whereClause.webinar = {
          webinarPlan: {
            consultantProfileId
          }
        };
        break;
      case AppointmentsType.CLASS:
        whereClause.class = {
          classPlans: {
            consultantProfileId
          }
        };
        break;
    }
  }

  if (consulteeProfileId) {
    whereClause.slotOfAppointment = {
      consulteeProfileId
    };
  }

  return await prisma.appointment.findMany({
    where: whereClause,
    include: {
      slotOfAppointment: {
        include: {
          consulteeProfile: true,
          slotOfAvailabilityWeekly: true,
          slotOfAvailabilityCustom: true,
        },
      },
      consultation: {
        include: {
          consultationPlan: true,
        },
      },
      subscription: {
        include: {
          plan: true,
        },
      },
      webinar: {
        include: {
          webinarPlan: true,
          topics: true,
        },
      },
      class: {
        include: {
          classPlans: true,
          topics: true,
        },
      },
      payment: true,
    },
  });
}