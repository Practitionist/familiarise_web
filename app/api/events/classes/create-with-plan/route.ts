import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      // Class Plan data
      title,
      description,
      durationInMonths,
      price,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      consultantProfileId,
      topicIds,
      certificateProvided,
      callsPerWeek,
      videoMeetings,
      emailSupport,
      classContents,
      // Additional fields for class instance
      status = "SCHEDULED",
      startDate,
    } = body;

    // Input validation
    if (
      !title ||
      !durationInMonths ||
      !price ||
      !maxParticipants ||
      !consultantProfileId ||
      !startDate ||
      !callsPerWeek ||
      !classContents?.length
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Calculate end date (startDate + durationInMonths)
    const start = new Date(startDate);
    const end = new Date(start);
    end.setMonth(end.getMonth() + durationInMonths);

    // Create class plan, instance, and appointments in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create the class plan
      const classPlan = await tx.classPlan.create({
        data: {
          title,
          description,
          durationInMonths,
          price,
          maxParticipants,
          language,
          level,
          prerequisites,
          materialProvided,
          learningOutcomes,
          certificateProvided,
          callsPerWeek,
          videoMeetings,
          emailSupport,
          consultantProfile: { connect: { id: consultantProfileId } },
          topics: topicIds
            ? { connect: topicIds.map((id: string) => ({ id })) }
            : undefined,
          classContents: {
            create: classContents.map((content: any) => ({
              title: content.title,
              description: content.description,
              contentType: content.contentType,
              contentUrl: content.contentUrl,
              order: content.order,
              hoursAllotted: content.hoursAllotted,
            })),
          },
        },
        include: {
          consultantProfile: true,
          topics: true,
          classContents: true,
        },
      });

      // 2. Create the class instance with appointments
      const classEvent = await tx.class.create({
        data: {
          status,
          startDate: start,
          endDate: end,
          classPlan: { connect: { id: classPlan.id } },
          // Create initial appointments for the first month
          appointments: {
            create: Array.from({ length: callsPerWeek * 4 }).map((_, index) => {
              const appointmentDate = new Date(start);
              appointmentDate.setDate(appointmentDate.getDate() + Math.floor(index / callsPerWeek) * 7);
              const slotStart = new Date(appointmentDate);
              const slotEnd = new Date(appointmentDate);
              slotEnd.setHours(slotEnd.getHours() + 1); // Default 1-hour slots

              return {
                appointmentType: "CLASS",
                slotsOfAppointment: {
                  create: {
                    slotStartTimeInUTC: slotStart,
                    slotEndTimeInUTC: slotEnd,
                    isTentative: true, // Mark as tentative until confirmed
                  },
                },
              };
            }),
          },
        },
        include: {
          classPlan: {
            include: {
              consultantProfile: true,
              topics: true,
              classContents: true,
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
            },
          },
          meetingRoom: true,
          waitlist: true,
        },
      });

      return { classPlan, classEvent };
    });

    return NextResponse.json({ data: result.classEvent }, { status: 201 });
  } catch (error) {
    console.error("Error creating class with plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the class" },
      { status: 500 },
    );
  }
} 