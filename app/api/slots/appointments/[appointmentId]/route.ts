import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, AppointmentsType } from "@prisma/client";

export async function GET(
    req: NextRequest,
    { params }: { params: { appointmentId: string } }
) {
    try {
        const appointment = await prisma.appointment.findUnique({
            where: { id: params.appointmentId },
            include: {
                slotOfAppointment: {
                    include: {
                        consulteeProfile: true,
                        slotOfAvailabilityWeekly: true,
                        slotOfAvailabilityCustom: true,
                    },
                },
                consultation: true,
                subscription: true,
                webinar: true,
                class: true,
            },
        });

        if (!appointment) {
            return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
        }

        return NextResponse.json(appointment, { status: 200 });
    } catch (error) {
        console.error("Error fetching appointment:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(
    req: NextRequest,
    { params }: { params: { appointmentId: string } }
) {
    try {
        const body = await req.json();

        if (!Object.values(AppointmentsType).includes(body.appointmentType)) {
            return NextResponse.json({ error: "Invalid appointment type" }, { status: 400 });
        }

        const eventTypeCount = [body.consultationId, body.subscriptionId, body.webinarId, body.classId].filter(Boolean).length;
        if (eventTypeCount !== 1) {
            return NextResponse.json({ error: "Exactly one event type must be specified" }, { status: 400 });
        }

        const newAppointment = await prisma.appointment.create({
            data: {
                appointmentType: body.appointmentType,
                slotOfAppointment: { connect: { id: body.slotOfAppointmentId } },
                consultation: body.consultationId ? { connect: { id: body.consultationId } } : undefined,
                subscription: body.subscriptionId ? { connect: { id: body.subscriptionId } } : undefined,
                webinar: body.webinarId ? { connect: { id: body.webinarId } } : undefined,
                class: body.classId ? { connect: { id: body.classId } } : undefined,
            },
            include: {
                slotOfAppointment: {
                    include: {
                        consulteeProfile: true,
                        slotOfAvailabilityWeekly: true,
                        slotOfAvailabilityCustom: true,
                    },
                },
                consultation: true,
                subscription: true,
                webinar: true,
                class: true,
            },
        });

        return NextResponse.json(newAppointment, { status: 201 });
    } catch (error) {
        console.error("Error creating appointment:", error);
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
            if (error.code === 'P2002') {
                return NextResponse.json({ error: "A unique constraint would be violated on Appointment" }, { status: 400 });
            }
        }
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function PUT(
    req: NextRequest,
    { params }: { params: { appointmentId: string } }
) {
    try {
        const body = await req.json();

        if (body.appointmentType && !Object.values(AppointmentsType).includes(body.appointmentType)) {
            return NextResponse.json({ error: "Invalid appointment type" }, { status: 400 });
        }

        const updatedAppointment = await prisma.appointment.update({
            where: { id: params.appointmentId },
            data: {
                appointmentType: body.appointmentType,
                slotOfAppointment: body.slotOfAppointmentId ? { connect: { id: body.slotOfAppointmentId } } : undefined,
                consultation: body.consultationId ? { connect: { id: body.consultationId } } : undefined,
                subscription: body.subscriptionId ? { connect: { id: body.subscriptionId } } : undefined,
                webinar: body.webinarId ? { connect: { id: body.webinarId } } : undefined,
                class: body.classId ? { connect: { id: body.classId } } : undefined,
            },
            include: {
                slotOfAppointment: {
                    include: {
                        consulteeProfile: true,
                        slotOfAvailabilityWeekly: true,
                        slotOfAvailabilityCustom: true,
                    },
                },
                consultation: true,
                subscription: true,
                webinar: true,
                class: true,
            },
        });

        return NextResponse.json(updatedAppointment, { status: 200 });
    } catch (error) {
        console.error("Error updating appointment:", error);
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
            if (error.code === 'P2025') {
                return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
            }
        }
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: { appointmentId: string } }
) {
    try {
        const deletedAppointment = await prisma.appointment.delete({
            where: { id: params.appointmentId },
            include: {
                slotOfAppointment: {
                    include: {
                        consulteeProfile: true,
                        slotOfAvailabilityWeekly: true,
                        slotOfAvailabilityCustom: true,
                    },
                },
                consultation: true,
                subscription: true,
                webinar: true,
                class: true,
            },
        });

        return NextResponse.json(deletedAppointment, { status: 200 });
    } catch (error) {
        console.error("Error deleting appointment:", error);
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
            if (error.code === 'P2025') {
                return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
            }
        }
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}