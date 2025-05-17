import {
  createDbMeetingSession,
  findDbMeetingSessionBySlot,
} from "@/actions/stream/meetings/meeting.action";
import {
  IAppointment,
  ISlotOfAppointment,
} from "@/app/dashboard/consultant/[consultantId]/types";
import type { Call } from "@stream-io/video-react-sdk";
import { StreamVideoClient } from "@stream-io/video-react-sdk";

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
 * Gets an existing meeting session ID from the DB or creates a new Stream call
 * and corresponding DB session if one doesn't exist for the appointment slot.
 * Uses server actions for DB operations.
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
    // 1. Try to find an existing meeting session via server action
    const existingMeetingSession = await findDbMeetingSessionBySlot(slot.id);

    let streamCallId: string;

    if (existingMeetingSession) {
      // 2a. Found existing session, use its Stream Call ID
      streamCallId = existingMeetingSession.streamCallId;
      console.log(
        `Using existing meeting session for slot ${slot.id}: ${streamCallId}`,
      );
      // Optional: Could potentially verify the call still exists on Stream side here if needed
      // const call = client.call('default', streamCallId);
      // await call.get(); // This would throw if the call doesn't exist
    } else {
      // 2b. No existing session found, create a new one
      streamCallId = crypto.randomUUID();
      console.log(
        `Creating new Stream call and DB session for slot ${slot.id}: ${streamCallId}`,
      );

      // 3. Create the Stream call
      const call: Call = client.call("default", streamCallId);
      const startsAt = slot.slotStartTimeInUTC
        ? new Date(slot.slotStartTimeInUTC).toISOString()
        : new Date().toISOString();

      // Determine title and description based on appointment type
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
      console.log(`Stream call ${streamCallId} created or retrieved.`);

      // 4. Create the corresponding record in the database via server action
      await createDbMeetingSession(slot, streamCallId);
      // Log message is now inside createDbMeetingSession action
    }

    // 5. Return the Stream Call ID (either existing or newly created)
    return streamCallId;
  } catch (error) {
    console.error(
      `Error in getOrCreateAppointmentMeeting for slot ${slot.id}:`,
      error,
    );
    // Wrap the original error
    if (error instanceof Error) {
      throw new Error(`Failed to get/create meeting session: ${error.message}`);
    }
    throw new Error(
      "An unknown error occurred while managing the appointment meeting session.",
    );
  }
};
