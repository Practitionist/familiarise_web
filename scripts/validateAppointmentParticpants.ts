import { TAppointment } from "@/types/appointment";
import prisma from "@/lib/prisma";

export const validateAppointmentParticipants = async (
  appointment: TAppointment,
) => {
  if (
    (appointment.appointmentType === "CONSULTATION" ||
      appointment.appointmentType === "SUBSCRIPTION") &&
    appointment.slotsOfAppointment[0].user?.length > 1
  ) {
    throw new Error(
      "Consultation and Subscription appointments can only have one participant",
    );
  }

  if (appointment.appointmentType === "WEBINAR") {
    const webinar_ = await prisma.webinar.findUnique({
      where: { id: appointment.webinarId! },
      include: { webinarPlan: true },
    });
    if (
      appointment.slotsOfAppointment[0].user?.length >
      webinar_!.webinarPlan.maxParticipants
    ) {
      throw new Error("Webinar is full");
    }
  }

  // Similar check for Class
  if (appointment.appointmentType === "CLASS") {
    const class_ = await prisma.class.findUnique({
      where: { id: appointment.classId! },
      include: { classPlan: true },
    });
    if (
      appointment.slotsOfAppointment[0].user?.length >
      class_!.classPlan.maxParticipants
    ) {
      throw new Error("Class is full");
    }
  }
};
