import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
    req: NextRequest,
    { params }: { params: { appointmentId: string } }
) {
    try {
        const appointment = await prisma.slotOfAppointment.findUnique({
            where: { id: params.appointmentId },
            include: {
                consulteeProfile: true,
                slotOfAppointmentRequest: {
                    include: {
                        slotOfAvailabiltyWeekly: true,
                        slotOfAvailabiltyCustom: true,
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

        const newAppointment = await prisma.slotOfAppointment.create({
            data: {
                consulteeProfile: { connect: { id: body.consulteeProfileId } },
                slotOfAppointmentRequest: { connect: { id: body.slotOfAppointmentRequestId } },
                appointmentsType: body.appointmentsType,
                consultation: body.consultationId ? { connect: { id: body.consultationId } } : undefined,
                subscription: body.subscriptionId ? { connect: { id: body.subscriptionId } } : undefined,
                webinar: body.webinarId ? { connect: { id: body.webinarId } } : undefined,
                class: body.classId ? { connect: { id: body.classId } } : undefined,
            },
            include: {
                consulteeProfile: true,
                slotOfAppointmentRequest: {
                    include: {
                        slotOfAvailabiltyWeekly: true,
                        slotOfAvailabiltyCustom: true,
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
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function PUT(
    req: NextRequest,
    { params }: { params: { appointmentId: string } }
) {
    try {
        const body = await req.json();

        const updatedAppointment = await prisma.slotOfAppointment.update({
            where: { id: params.appointmentId },
            data: {
                consulteeProfile: { connect: { id: body.consulteeProfileId } },
                slotOfAppointmentRequest: { connect: { id: body.slotOfAppointmentRequestId } },
                appointmentsType: body.appointmentsType,
                consultation: body.consultationId ? { connect: { id: body.consultationId } } : undefined,
                subscription: body.subscriptionId ? { connect: { id: body.subscriptionId } } : undefined,
                webinar: body.webinarId ? { connect: { id: body.webinarId } } : undefined,
                class: body.classId ? { connect: { id: body.classId } } : undefined,
            },
            include: {
                consulteeProfile: true,
                slotOfAppointmentRequest: {
                    include: {
                        slotOfAvailabiltyWeekly: true,
                        slotOfAvailabiltyCustom: true,
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
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: { appointmentId: string } }
) {
    try {
        const deletedAppointment = await prisma.slotOfAppointment.delete({
            where: { id: params.appointmentId },
            include: {
                consulteeProfile: true,
                slotOfAppointmentRequest: {
                    include: {
                        slotOfAvailabiltyWeekly: true,
                        slotOfAvailabiltyCustom: true,
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
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}