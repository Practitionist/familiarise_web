import prisma from "@/lib/prisma";
import { DayOfWeek, ScheduleType, UserRole } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const body = await req.json();

    // Validate required fields
    const requiredFields = ['personalInfo', 'role'];
    for (const field of requiredFields) {
      if (!body[field]) {
        return NextResponse.json({ error: `Missing required field: ${field}` }, { status: 400 });
      }
    }

    // Check if the user exists
    const existingUser = await prisma.user.findUnique({
      where: { id },
      include: {
        consultantProfile: {
          include: {
            slotsOfAvailabilityWeekly: true,
            slotsOfAvailabilityCustom: true,
          },
        },
        consulteeProfile: true,
        staffProfile: true,
      },
    });

    if (!existingUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Validate role
    if (!Object.values(UserRole).includes(body.role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
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
    if (body.role === UserRole.CONSULTANT) {
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
          rating: 0,
          description,
          tags: typeof tags === "string" ? tags.split(",").map(tag => tag.trim()) : tags,
        },
      });

      userProfileData.consultantProfileId = consultantProfile.id;

      if (scheduleTypeEnum === ScheduleType.WEEKLY && weeklySlots) {
        const existingWeeklySlots = existingUser.consultantProfile?.slotsOfAvailabilityWeekly || [];
        const updatedWeeklySlots = createWeeklySlots(weeklySlots, existingWeeklySlots);
        await prisma.slotOfAvailabilityWeekly.deleteMany({ where: { consultantProfileId: consultantProfile.id } });
        await prisma.slotOfAvailabilityWeekly.createMany({
          data: updatedWeeklySlots.map(slot => ({ ...slot, consultantProfileId: consultantProfile.id })),
        });
      } else if (scheduleTypeEnum === ScheduleType.CUSTOM && customSlots) {
        const existingCustomSlots = existingUser.consultantProfile?.slotsOfAvailabilityCustom || [];
        const updatedCustomSlots = createCustomSlots(customSlots, existingCustomSlots);
        await prisma.slotOfAvailabilityCustom.deleteMany({ where: { consultantProfileId: consultantProfile.id } });
        await prisma.slotOfAvailabilityCustom.createMany({
          data: updatedCustomSlots.map(slot => ({ ...slot, consultantProfileId: consultantProfile.id })),
        });
      }

    } else if (body.role === UserRole.CONSULTEE) {
      const consulteeProfileData = {
        education: body.consulteeProfile.education,
        occupation: body.consulteeProfile.occupation,
        aboutMe: body.consulteeProfile.aboutMe,
        preferredCommunicationMethod: body.consulteeProfile.preferredCommunicationMethod,
        preferredLanguage: body.consulteeProfile.preferredLanguage,
        specialRequirements: body.consulteeProfile.specialRequirements,
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

    } else if (body.role === UserRole.STAFF) {
      const staffProfileData = {
        department: body.staffProfile.department,
        position: body.staffProfile.position,
        permissions: body.staffProfile.permissions,
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
      { error: error instanceof Error ? error.message : "An error occurred while updating onboarding information" },
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
