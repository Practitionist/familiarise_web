"use server";

import prisma from "@/lib/prisma";
import { ISlotOfAppointment } from "@/app/dashboard/consultant/[consultantId]/types";
import { MeetingSession } from "@prisma/client"; // Assuming MeetingSession type exists

/**
 * Finds an existing meeting session in the database by slot ID.
 * This function is intended to run on the server only.
 * @param slotId The ID of the appointment slot.
 * @returns The MeetingSession object if found, otherwise null.
 */
export const findDbMeetingSessionBySlot = async (
  slotId: string,
): Promise<MeetingSession | null> => {
  try {
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { slotOfAppointmentId: slotId },
    });

    if (meetingSession) {
      console.log(
        `Found existing DB meeting session ${meetingSession.id} for slot ${slotId}.`,
      );
    } else {
      console.log(`No existing DB session found for slot ${slotId}.`);
    }
    return meetingSession;
  } catch (error) {
    console.error(
      `Error finding DB meeting session for slot ${slotId}:`,
      error,
    );
    // Don't throw here, return null to indicate not found
    // Re-throwing might be appropriate depending on desired error handling
    return null;
  }
};

/**
 * Creates a new meeting session in the database.
 * This function is intended to run on the server only.
 * @param slot The appointment slot for which to create the session.
 * @param streamCallId The Stream Call ID to associate with the new session.
 * @returns The newly created MeetingSession object.
 */
export const createDbMeetingSession = async (
  slot: ISlotOfAppointment,
  streamCallId: string,
): Promise<MeetingSession> => {
  try {
    console.log(
      `Creating new DB session for slot ${slot.id} with Stream ID ${streamCallId}.`,
    );
    const meetingSession = await prisma.meetingSession.create({
      data: {
        streamCallId: streamCallId,
        platform: "STREAM", // Assuming STREAM is the platform
        slotOfAppointment: {
          connect: { id: slot.id },
        },
      },
    });
    console.log(
      `Stored new meeting session ${meetingSession.id} in DB linking slot ${slot.id}.`,
    );
    return meetingSession;
  } catch (error) {
    console.error(
      `Error creating DB meeting session for slot ${slot.id}:`,
      error,
    );
    if (error instanceof Error) {
      throw new Error(`Failed to create DB meeting session: ${error.message}`);
    }
    throw new Error(
      "An unknown error occurred while creating the DB meeting session.",
    );
  }
};
