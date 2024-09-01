import prisma from "@/lib/prisma";
import { DayOfWeek, ScheduleType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const body = await req.json();

    // Check if the user exists
    const existingUser = await prisma.user.findUnique({
      where: { id },
      include: {
        consultantProfile: {
          include: {
            slotsOfAvailabiltyWeekly: true,
            slotsOfAvailabiltyCustom: true,
          },
        },
        consulteeProfile: true,
        staffProfile: true,
      },
    });

    if (!existingUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        name: body.personalInfo.name,
        email: body.personalInfo.email,
        phone: body.personalInfo.phone,
        address: body.personalInfo.address,
        role: body.role,
        onboardingCompleted: true,
        currentTimezone: body.personalInfo.currentTimezone,
      },
    });

    let userProfileData: any = {};
    if (body.role === "CONSULTANT") {
      const {
        specialization,
        experience,
        location,
        domain,
        subDomains,
        scheduleType,
        weeklySlots,
        customSlots,
        description,
        tags,
      } = body.consultantProfile;

      const subDomainsArray =
        typeof subDomains === "string"
          ? subDomains.split(",").map((item) => item.trim())
          : subDomains;

      const scheduleTypeEnum = scheduleType.toUpperCase() as ScheduleType;

      const consultantProfile = await prisma.consultantProfile.upsert({
        where: { userId: id },
        update: {
          specialization,
          experience,
          location,
          domain,
          subDomains: subDomainsArray,
          scheduleType: scheduleTypeEnum,
          description,
          tags: typeof tags === "string" ? tags.split(",").map(tag => tag.trim()) : tags,
        },
        create: {
          userId: id,
          specialization,
          experience,
          location,
          domain,
          subDomains: subDomainsArray,
          scheduleType: scheduleTypeEnum,
          onlineStatus: true,
          rating: 0,
          description,
          tags: typeof tags === "string" ? tags.split(",").map(tag => tag.trim()) : tags,
        },
      });

      userProfileData.consultantProfileId = consultantProfile.id;

      if (scheduleTypeEnum === ScheduleType.WEEKLY && weeklySlots) {
        const existingWeeklySlots = existingUser.consultantProfile?.slotsOfAvailabiltyWeekly || [];
        const updatedWeeklySlots = createWeeklySlots(weeklySlots, existingWeeklySlots);
        await prisma.slotOfAvailabiltyWeekly.deleteMany({ where: { consultantProfileId: consultantProfile.id } });
        await prisma.slotOfAvailabiltyWeekly.createMany({
          data: updatedWeeklySlots.map(slot => ({ ...slot, consultantProfileId: consultantProfile.id })),
        });
      } else if (scheduleTypeEnum === ScheduleType.CUSTOM && customSlots) {
        const existingCustomSlots = existingUser.consultantProfile?.slotsOfAvailabiltyCustom || [];
        const updatedCustomSlots = createCustomSlots(customSlots, existingCustomSlots);
        await prisma.slotOfAvailabiltyCustom.deleteMany({ where: { consultantProfileId: consultantProfile.id } });
        await prisma.slotOfAvailabiltyCustom.createMany({
          data: updatedCustomSlots.map(slot => ({ ...slot, consultantProfileId: consultantProfile.id })),
        });
      }

    } else if (body.role === "CONSULTEE") {
      const consulteeProfileData = {
        education: body.consulteeProfile.education,
        occupation: body.consulteeProfile.occupation,
        aboutMe: body.consulteeProfile.aboutMe,
        preferredCommunicationMethod: body.consulteeProfile.preferredCommunicationMethod,
        preferredLanguage: body.consulteeProfile.preferredLanguage,
        specialRequirements: body.consulteeProfile.specialRequirements,
        onlineStatus: true,
        interests: JSON.stringify(body.consulteeProfile.interests),
      };
    
      const consulteeProfile = await prisma.consulteeProfile.upsert({
        where: { userId: id },
        update: consulteeProfileData,
        create: {
          userId: id,
          ...consulteeProfileData,
        },
      });

      userProfileData.consulteeProfileId = consulteeProfile.id;

    } else if (body.role === "STAFF") {
      const staffProfileData = {
        department: body.staffProfile.department,
        position: body.staffProfile.position,
        responsibilities: body.staffProfile.responsibilities,
      };

      const staffProfile = await prisma.staffProfile.upsert({
        where: { userId: id },
        update: staffProfileData,
        create: {
          userId: id,
          ...staffProfileData,
        },
      });

      userProfileData.staffProfileId = staffProfile.id;
    }

    // Update the user with the correct profile ID
    const finalUpdatedUser = await prisma.user.update({
      where: { id },
      data: userProfileData,
    });

    return NextResponse.json({
      message: "Onboarding information updated successfully",
      user: finalUpdatedUser,
    });
  } catch (error: unknown) {
    console.error("Error updating onboarding information:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Something went wrong" },
      { status: 500 }
    );
  }
}

function createWeeklySlots(weeklySlots: any, existingSlots: any[]) {
  const updatedSlots = [];

  for (const [day, daySlots] of Object.entries(weeklySlots)) {
    for (const slot of daySlots as any) {
      const newSlot = {
        dayOfWeekforStartTimeInUTC: day.toUpperCase() as DayOfWeek,
        slotStartTimeInUTC: new Date(`1970-01-01T${slot.startTime}:00Z`).toISOString(),
        dayOfWeekforEndTimeInUTC: day.toUpperCase() as DayOfWeek,
        slotEndTimeInUTC: new Date(`1970-01-01T${slot.endTime}:00Z`).toISOString(),
      };

      const overlappingSlot = findOverlappingWeeklySlot(existingSlots, newSlot);
      if (overlappingSlot) {
        // Update the existing slot
        Object.assign(overlappingSlot, newSlot);
        updatedSlots.push(overlappingSlot);
      } else {
        // Create a new slot
        updatedSlots.push(newSlot);
      }
    }
  }

  return addBreaksToSlots(updatedSlots);
}

function createCustomSlots(customSlots: any, existingSlots: any[]) {
  const updatedSlots = [];

  for (const [date, dateSlots] of Object.entries(customSlots)) {
    for (const slot of dateSlots as any) {
      const newSlot = {
        slotStartTimeInUTC: new Date(`${date}T${slot.startTime}:00Z`).toISOString(),
        slotEndTimeInUTC: new Date(`${date}T${slot.endTime}:00Z`).toISOString(),
      };

      const overlappingSlot = findOverlappingCustomSlot(existingSlots, newSlot);
      if (overlappingSlot) {
        // Update the existing slot
        Object.assign(overlappingSlot, newSlot);
        updatedSlots.push(overlappingSlot);
      } else {
        // Create a new slot
        updatedSlots.push(newSlot);
      }
    }
  }

  return addBreaksToSlots(updatedSlots);
}

function findOverlappingWeeklySlot(existingSlots: any[], newSlot: any) {
  return existingSlots.find(slot =>
    slot.dayOfWeekforStartTimeInUTC === newSlot.dayOfWeekforStartTimeInUTC &&
    isOverlapping(slot, newSlot)
  );
}

function findOverlappingCustomSlot(existingSlots: any[], newSlot: any) {
  return existingSlots.find(slot =>
    isSameDay(new Date(slot.slotStartTimeInUTC), new Date(newSlot.slotStartTimeInUTC)) &&
    isOverlapping(slot, newSlot)
  );
}

function isOverlapping(slot1: any, slot2: any) {
  const start1 = new Date(slot1.slotStartTimeInUTC);
  const end1 = new Date(slot1.slotEndTimeInUTC);
  const start2 = new Date(slot2.slotStartTimeInUTC);
  const end2 = new Date(slot2.slotEndTimeInUTC);

  return (start1 < end2 && start2 < end1);
}

function isSameDay(date1: Date, date2: Date) {
  return date1.getUTCFullYear() === date2.getUTCFullYear() &&
    date1.getUTCMonth() === date2.getUTCMonth() &&
    date1.getUTCDate() === date2.getUTCDate();
}

function addBreaksToSlots(slots: any[]) {
  const slotsWithBreaks = [];

  for (const slot of slots) {
    const breakBefore = {
      ...slot,
      slotStartTimeInUTC: new Date(new Date(slot.slotStartTimeInUTC).getTime() - 15 * 60 * 1000).toISOString(),
      slotEndTimeInUTC: slot.slotStartTimeInUTC,
    };

    const breakAfter = {
      ...slot,
      slotStartTimeInUTC: slot.slotEndTimeInUTC,
      slotEndTimeInUTC: new Date(new Date(slot.slotEndTimeInUTC).getTime() + 15 * 60 * 1000).toISOString(),
    };

    slotsWithBreaks.push(breakBefore, slot, breakAfter);
  }

  return slotsWithBreaks.filter(slot => !isBreakSlot(slot));
}

function isBreakSlot(slot: any) {
  return new Date(slot.slotEndTimeInUTC).getTime() - new Date(slot.slotStartTimeInUTC).getTime() === 15 * 60 * 1000;
}
