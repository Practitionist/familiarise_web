import { StreamVideoClient } from "@stream-io/video-react-sdk";
import type { Call } from "@stream-io/video-react-sdk";
import {
  IAppointment,
  ISlotOfAppointment,
} from "@/app/dashboard/consultant/[consultantId]/types";
import prisma from "@/lib/prisma";

/**
 * Creates a new meeting (This function might need less usage now)
 * @param client The Stream Video client
 * @param options Meeting options
 * @returns The meeting ID (Stream Call ID)
 */
export const createMeeting = async (
  client: StreamVideoClient,
  options: {
    title: string;
    dateTime?: Date;
    description?: string;
    link?: string;
  },
) => {
  if (!client) {
    throw new Error("Stream client not initialized");
  }

  try {
    const id = crypto.randomUUID();
    const call: Call = client.call("default", id);

    if (!call) {
      throw new Error("Failed to create call");
    }

    const startsAt =
      options.dateTime?.toISOString() ?? new Date(Date.now()).toISOString();
    const description = options.description ?? "Instant Meeting";

    await call.getOrCreate({
      data: {
        starts_at: startsAt,
        custom: {
          title: options.title,
          description: description,
          link: options.link,
        },
      },
    });

    console.log("Created generic meeting:", id);
    return id;
  } catch (error) {
    console.error("Error creating meeting:", error);
    throw error;
  }
};

/**
 * Gets or creates a meeting session for a specific appointment slot.
 * @param client The Stream Video client
 * @param appointment The appointment details
 * @param slot The specific slot of the appointment
 * @returns The Stream Call ID for the meeting
 */
export const getOrCreateAppointmentMeeting = async (
  client: StreamVideoClient,
  appointment: IAppointment,
  slot: ISlotOfAppointment,
): Promise<string> => {
  if (!client) {
    throw new Error("Stream client not initialized");
  }
  if (!appointment || !slot) {
    throw new Error("Appointment or Slot data is missing.");
  }

  try {
    let meetingSession = await prisma.meetingSession.findUnique({
      where: { slotOfAppointmentId: slot.id },
    });

    let streamCallId: string;

    if (meetingSession) {
      streamCallId = meetingSession.streamCallId;
      console.log(
        `Found existing meeting session for slot ${slot.id}: ${streamCallId}`,
      );
    } else {
      streamCallId = crypto.randomUUID();
      console.log(
        `Creating new meeting session for slot ${slot.id}: ${streamCallId}`,
      );

      const call: Call = client.call("default", streamCallId);
      const startsAt = slot.slotStartTimeInUTC
        ? new Date(slot.slotStartTimeInUTC).toISOString()
        : new Date().toISOString();

      let title = `Meeting for Appointment ${appointment.id}`;
      let description = `${appointment.appointmentType} Meeting`;

      if (appointment.consultation?.requestedBy?.user?.name) {
        title = `${appointment.appointmentType} with ${appointment.consultation.requestedBy.user.name}`;
      } else if (appointment.subscription?.requestedBy?.user?.name) {
        title = `${appointment.appointmentType} with ${appointment.subscription.requestedBy.user.name}`;
      } else if (appointment.webinar?.webinarPlan?.title) {
        title = `Webinar: ${appointment.webinar.webinarPlan.title}`;
        description = `Webinar Session for ${appointment.webinar.webinarPlan.title}`;
      } else if (appointment.class?.classPlan?.title) {
        title = `Class: ${appointment.class.classPlan.title}`;
        description = `Class Session for ${appointment.class.classPlan.title}`;
      }

      await call.getOrCreate({
        data: {
          starts_at: startsAt,
          custom: {
            title: title,
            description: description,
            appointmentId: appointment.id,
            slotId: slot.id,
            appointmentType: appointment.appointmentType,
          },
        },
      });

      meetingSession = await prisma.meetingSession.create({
        data: {
          streamCallId: streamCallId,
          platform: "STREAM",
          slotOfAppointment: {
            connect: { id: slot.id },
          },
        },
      });
      console.log(
        `Stored new meeting session ${meetingSession.id} in DB linking slot ${slot.id}.`,
      );
    }

    return streamCallId;
  } catch (error) {
    console.error(
      `Error getting or creating meeting for slot ${slot.id}:`,
      error,
    );
    if (error instanceof Error) {
      throw new Error(`Failed to get/create meeting: ${error.message}`);
    }
    throw new Error(
      "An unknown error occurred while managing the meeting session.",
    );
  }
};
