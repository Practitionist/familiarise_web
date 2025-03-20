import { StreamVideoClient } from "@stream-io/video-react-sdk";
import type { Call } from "@stream-io/video-react-sdk";
import { IAppointment } from "@/app/dashboard/consultant/[consultantId]/types";

/**
 * Combines two UUIDs into a 64-character string by interleaving their characters
 * @param uuid1 First UUID
 * @param uuid2 Second UUID
 * @returns Combined 64-character string
 */
export function combineUUIDs(uuid1: string, uuid2: string): string {
  // Remove dashes from both UUIDs to get clean strings
  const cleanUuid1 = uuid1.replace(/-/g, "");
  const cleanUuid2 = uuid2.replace(/-/g, "");

  // Interleave the characters
  let combined = "";
  const maxLength = Math.max(cleanUuid1.length, cleanUuid2.length);

  for (let i = 0; i < maxLength; i++) {
    if (i < cleanUuid1.length) combined += cleanUuid1[i];
    if (i < cleanUuid2.length) combined += cleanUuid2[i];
  }

  return combined;
}

/**
 * Extracts the original UUIDs from the combined string
 * @param combinedString The combined 64-character string
 * @returns Object containing the two original UUIDs
 */
export function extractUUIDs(combinedString: string): {
  uuid1: string;
  uuid2: string;
} {
  let uuid1 = "";
  let uuid2 = "";

  // De-interleave the characters
  for (let i = 0; i < combinedString.length; i++) {
    if (i % 2 === 0) {
      uuid1 += combinedString[i];
    } else {
      uuid2 += combinedString[i];
    }
  }

  // Re-add the dashes in the correct UUID format (8-4-4-4-12)
  const formatUUID = (cleanUUID: string): string => {
    return (
      cleanUUID.substring(0, 8) +
      "-" +
      cleanUUID.substring(8, 12) +
      "-" +
      cleanUUID.substring(12, 16) +
      "-" +
      cleanUUID.substring(16, 20) +
      "-" +
      cleanUUID.substring(20)
    );
  };

  return {
    uuid1: formatUUID(uuid1),
    uuid2: formatUUID(uuid2),
  };
}

/**
 * Creates a new meeting
 * @param client The Stream Video client
 * @param options Meeting options
 * @returns The meeting ID
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

    return id;
  } catch (error) {
    console.error("Error creating meeting:", error);
    throw error;
  }
};

/**
 * Joins a meeting for a specific appointment
 * @param client The Stream Video client
 * @param appointment The appointment to join
 * @returns The meeting ID
 */
export const joinAppointmentMeeting = async (
  client: StreamVideoClient,
  appointment: IAppointment,
) => {
  if (!client) {
    throw new Error("Stream client not initialized");
  }

  try {
    // Check if the appointment ID contains a hyphen (indicating it's a composite ID)
    const idParts = appointment.id.split("-");

    let appointmentId, slotId;
    if (idParts.length > 5) {
      // This is a composite ID in the format "appointmentId-slotId"
      // A UUID has 5 parts separated by 4 hyphens, so we need to reconstruct them
      appointmentId = idParts.slice(0, 5).join("-");
      slotId = idParts.slice(5).join("-");
    } else {
      // This is just a regular appointment ID
      appointmentId = appointment.id;
      // Use a default slot ID or the first slot if available
      slotId =
        appointment.slotsOfAppointment &&
        appointment.slotsOfAppointment.length > 0
          ? appointment.slotsOfAppointment[0].id
          : "00000000-0000-0000-0000-000000000000";
    }

    // Combine the two UUIDs into a 64-character string
    const meetingId = combineUUIDs(appointmentId, slotId);
    console.log("Joining appointment meeting:", meetingId);

    const call: Call = client.call("default", meetingId);

    if (!call) {
      throw new Error("Failed to create call");
    }

    // Get appointment details
    const appointmentType = appointment.appointmentType;
    let clientName = "Client";

    // Extract client name based on appointment type
    if (appointment.consultation?.requestedBy?.user?.name) {
      clientName = appointment.consultation.requestedBy.user.name;
    } else if (appointment.subscription?.requestedBy?.user?.name) {
      clientName = appointment.subscription.requestedBy.user.name;
    } else if (appointment.webinar?.webinarPlan?.title) {
      // For webinars, use the webinar title
      clientName = `Webinar: ${appointment.webinar.webinarPlan.title}`;
    } else if (appointment.class?.classPlan?.title) {
      // For classes, use the class title
      clientName = `Class: ${appointment.class.classPlan.title}`;
    }

    // Create the meeting with appointment details
    await call.getOrCreate({
      data: {
        starts_at: new Date().toISOString(),
        custom: {
          title: `${appointmentType} with ${clientName}`,
          description: `${appointmentType} Meeting`,
          appointmentId: appointment.id,
          appointmentType: appointmentType,
        },
      },
    });

    return meetingId;
  } catch (error) {
    console.error("Error joining appointment meeting:", error);
    throw error;
  }
};
