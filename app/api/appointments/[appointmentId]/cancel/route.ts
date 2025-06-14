import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { notifyAppointmentUpdate } from "@/utils/realTimeNotifications";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId } = await params;

    // Start transaction
    const result = await prisma.$transaction(async (tx) => {
      // Get appointment details
      const appointment = await tx.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          consultation: {
            include: {
              consultationPlan: {
                include: {
                  consultantProfile: {
                    select: { user: { select: { id: true } } }
                  }
                }
              }
            }
          },
          subscription: {
            include: {
              subscriptionPlan: {
                include: {
                  consultantProfile: {
                    select: { user: { select: { id: true } } }
                  }
                }
              }
            }
          },
          webinar: {
            include: {
              webinarPlan: {
                include: {
                  consultantProfile: {
                    select: { user: { select: { id: true } } }
                  }
                }
              }
            }
          },
          class: {
            include: {
              classPlan: {
                include: {
                  consultantProfile: {
                    select: { user: { select: { id: true } } }
                  }
                }
              }
            }
          },
        },
      });

      if (!appointment) {
        throw new Error("Appointment not found");
      }

      // Update appointment status based on type
      if (appointment.consultation) {
        await tx.consultation.update({
          where: { id: appointment.consultation.id },
          data: { requestStatus: "CANCELLED" },
        });
      } else if (appointment.subscription) {
        await tx.subscription.update({
          where: { id: appointment.subscription.id },
          data: { requestStatus: "CANCELLED" },
        });
      } else if (appointment.webinar) {
        await tx.webinar.update({
          where: { id: appointment.webinar.id },
          data: { status: "CANCELLED" },
        });
      } else if (appointment.class) {
        await tx.class.update({
          where: { id: appointment.class.id },
          data: { status: "CANCELLED" },
        });
      }

      // Delete slots
      await tx.slotOfAppointment.deleteMany({
        where: { appointmentId },
      });

      // Delete appointment
      await tx.appointment.delete({
        where: { id: appointmentId },
      });

      return { success: true, appointment };
    });

    // Trigger real-time notification for cancellation
    if (result.appointment) {
      const appointment = result.appointment;
      let consultantId = null;

      if (appointment.consultation?.consultationPlan?.consultantProfile?.user?.id) {
        consultantId = appointment.consultation.consultationPlan.consultantProfile.user.id;
      } else if (appointment.subscription?.subscriptionPlan?.consultantProfile?.user?.id) {
        consultantId = appointment.subscription.subscriptionPlan.consultantProfile.user.id;
      } else if (appointment.webinar?.webinarPlan?.consultantProfile?.user?.id) {
        consultantId = appointment.webinar.webinarPlan.consultantProfile.user.id;
      } else if (appointment.class?.classPlan?.consultantProfile?.user?.id) {
        consultantId = appointment.class.classPlan.consultantProfile.user.id;
      }

      if (consultantId) {
        notifyAppointmentUpdate(consultantId, appointmentId, {
          action: 'cancellation',
          appointmentType: appointment.consultation ? 'consultation' : 
                          appointment.subscription ? 'subscription' :
                          appointment.webinar ? 'webinar' : 'class'
        });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error canceling appointment:", error);
    return NextResponse.json(
      { error: "Failed to cancel appointment" },
      { status: 500 },
    );
  }
}
