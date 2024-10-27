import { NextRequest, NextResponse } from 'next/server';
import prisma from "@/lib/prisma";
import { AppointmentsType } from '@prisma/client';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  
  const type = searchParams.get('type')?.toUpperCase();
  const consultantProfileId = searchParams.get('consultantProfileId');
  const consulteeProfileId = searchParams.get('consulteeProfileId');
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '10');

  if (type && !Object.values(AppointmentsType).includes(type as AppointmentsType)) {
    return NextResponse.json({ error: 'Invalid appointment type' }, { status: 400 });
  }

  try {
    const { appointments, total } = await getAppointments(type as AppointmentsType | undefined, consultantProfileId, consulteeProfileId, page, limit);
    return NextResponse.json({
      data: appointments,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      }
    });
  } catch (error) {
    console.error('Error fetching appointments:', error);
    return NextResponse.json({ error: 'An error occurred while fetching appointments' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { appointmentType, consulteeProfileId, slotStartTimeInUTC, slotEndTimeInUTC, ...appointmentData } = body;

    if (!appointmentType || !consulteeProfileId || !slotStartTimeInUTC || !slotEndTimeInUTC) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const newAppointment = await prisma.appointment.create({
      data: {
        appointmentType,
        ...appointmentData,
        slotOfAppointment: {
          create: {
            consulteeProfile: { connect: { id: consulteeProfileId } },
            slotStartTimeInUTC: new Date(slotStartTimeInUTC),
            slotEndTimeInUTC: new Date(slotEndTimeInUTC),
          },
        },
      },
      include: {
        slotOfAppointment: {
          include: {
            consulteeProfile: true,
          },
        },
        consultation: true,
        subscription: true,
        webinar: true,
        class: true,
        payment: true,
      },
    });

    return NextResponse.json({ data: newAppointment }, { status: 201 });
  } catch (error) {
    console.error('Error creating appointment:', error);
    return NextResponse.json({ error: 'An error occurred while creating the appointment' }, { status: 500 });
  }
}

async function getAppointments(type?: AppointmentsType, consultantProfileId?: string | null, consulteeProfileId?: string | null, page: number = 1, limit: number = 10) {
  const skip = (page - 1) * limit;
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
          classPlan: {
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

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where: whereClause,
      include: {
        slotOfAppointment: {
          include: {
            consulteeProfile: true,
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
          },
        },
        class: {
          include: {
            classPlan: true,
          },
        },
        payment: true,
      },
      skip,
      take: limit,
    }),
    prisma.appointment.count({ where: whereClause }),
  ]);

  return { appointments, total };
}
