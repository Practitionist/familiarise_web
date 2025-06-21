import { isValidTimeRange } from "@/utils/timeSlotValidation";
import prisma from "@/lib/prisma";
import { ConsultationMode, ScheduleType, UserRole } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    console.log(
      "Received request to update onboarding information",
      JSON.stringify(params, null, 2),
    );
    const { id } = await params;
    const body = await req.json();
    console.log("Request Body:", JSON.stringify(body, null, 2));

    validateRequiredFields(body);
    const existingUser = await getExistingUser(id);
    validateRole(body.role);

    const updatedUser = await updateUser(id, body);
    const userProfileData = await updateUserProfile(id, body, existingUser);

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
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "An error occurred while updating onboarding information",
      },
      { status: 500 },
    );
  }
}

function validateRequiredFields(body: any) {
  const requiredFields = ["name", "email", "role"];
  for (const field of requiredFields) {
    if (!body[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
}

async function getExistingUser(id: string) {
  const existingUser = await prisma.user.findUnique({
    where: { id },
    include: {
      consultantProfile: {
        include: {
          slotsOfAvailabilityWeekly: true,
          slotsOfAvailabilityCustom: true,
          domain: true,
          subDomains: true,
          tags: true,
        },
      },
      consulteeProfile: true,
      staffProfile: true,
    },
  });

  if (!existingUser) {
    throw new Error("User not found");
  }

  return existingUser;
}

function validateRole(role: string) {
  if (!Object.values(UserRole).includes(role as UserRole)) {
    throw new Error("Invalid role");
  }
}

async function updateUser(id: string, body: any) {
  return prisma.user.update({
    where: { id },
    data: {
      name: body.name,
      email: body.email,
      phone: body.phone,
      address: body.address,
      role: body.role as UserRole,
      onboardingCompleted: true,
      currentTimezone: body.currentTimezone,
    },
  });
}

async function updateUserProfile(id: string, body: any, existingUser: any) {
  switch (body.role) {
    case UserRole.CONSULTANT:
      return updateConsultantProfile(id, body, existingUser);
    case UserRole.CONSULTEE:
      return updateConsulteeProfile(id, body);
    case UserRole.STAFF:
      return updateStaffProfile(id, body);
    default:
      throw new Error("Invalid role");
  }
}
async function updateConsultantProfile(
  id: string,
  body: any,
  existingUser: any,
) {
  const profileData = body.consultantProfile?.create;
  if (!profileData) {
    throw new Error("Missing consultant profile data");
  }

  const scheduleTypeEnum = (
    profileData.scheduleType || "WEEKLY"
  ).toUpperCase() as ScheduleType;
  const domainId = profileData.domain?.connect?.id;
  if (!domainId) {
    throw new Error("Domain ID is required");
  }

  // First create/update the consultant profile
  const consultantProfile = await prisma.consultantProfile.upsert({
    where: { userId: id },
    create: {
      userId: id,
      description: profileData.description || "",
      qualifications: profileData.qualifications || "",
      specialization: profileData.specialization || "",
      experience: profileData.experience || 0,
      scheduleType: scheduleTypeEnum,
      rating: 0,
      domainId: domainId,
    },
    update: {
      description: profileData.description || "",
      qualifications: profileData.qualifications || "",
      specialization: profileData.specialization || "",
      experience: profileData.experience || 0,
      scheduleType: scheduleTypeEnum,
      domainId: domainId,
    },
  });

  // Then update the relationships
  if (profileData.subDomains?.connect?.length) {
    await prisma.consultantProfile.update({
      where: { id: consultantProfile.id },
      data: {
        subDomains: {
          set: profileData.subDomains.connect,
        },
      },
    });
  }

  if (profileData.tags?.connect?.length) {
    await prisma.consultantProfile.update({
      where: { id: consultantProfile.id },
      data: {
        tags: {
          set: profileData.tags.connect,
        },
      },
    });
  }

  // Update slots based on schedule type
  if (
    scheduleTypeEnum === ScheduleType.WEEKLY &&
    profileData.slotsOfAvailabilityWeekly?.create?.length
  ) {
    await prisma.slotOfAvailabilityWeekly.deleteMany({
      where: { consultantProfileId: consultantProfile.id },
    });

    // Filter out invalid slots before creating
    const validWeeklySlots =
      profileData.slotsOfAvailabilityWeekly.create.filter((slot: any) =>
        isValidTimeRange(
          slot.slotStartTimeInUTC.split("T")[1].slice(0, 5),
          slot.slotEndTimeInUTC.split("T")[1].slice(0, 5),
        ),
      );

    if (validWeeklySlots.length > 0) {
      await prisma.slotOfAvailabilityWeekly.createMany({
        data: validWeeklySlots.map((slot: any) => ({
          dayOfWeekforStartTimeInUTC: slot.dayOfWeekforStartTimeInUTC,
          slotStartTimeInUTC: slot.slotStartTimeInUTC,
          dayOfWeekforEndTimeInUTC: slot.dayOfWeekforEndTimeInUTC,
          slotEndTimeInUTC: slot.slotEndTimeInUTC,
          consultantProfileId: consultantProfile.id,
        })),
      });
    }
  }

  if (
    scheduleTypeEnum === ScheduleType.CUSTOM &&
    profileData.slotsOfAvailabilityCustom?.create?.length
  ) {
    await prisma.slotOfAvailabilityCustom.deleteMany({
      where: { consultantProfileId: consultantProfile.id },
    });

    // Filter out invalid slots before creating
    const validCustomSlots =
      profileData.slotsOfAvailabilityCustom.create.filter((slot: any) =>
        isValidTimeRange(
          slot.slotStartTimeInUTC.split("T")[1].slice(0, 5),
          slot.slotEndTimeInUTC.split("T")[1].slice(0, 5),
        ),
      );

    if (validCustomSlots.length > 0) {
      await prisma.slotOfAvailabilityCustom.createMany({
        data: validCustomSlots.map((slot: any) => ({
          slotStartTimeInUTC: slot.slotStartTimeInUTC,
          slotEndTimeInUTC: slot.slotEndTimeInUTC,
          consultantProfileId: consultantProfile.id,
        })),
      });
    }
  }

  return { consultantProfileId: consultantProfile.id };
}

async function updateConsulteeProfile(id: string, body: any) {
  const profileData = body.consulteeProfile?.create;
  if (!profileData) {
    throw new Error("Missing consultee profile data");
  }

  // Convert arrays to comma-separated strings
  const interests = Array.isArray(profileData.interests)
    ? profileData.interests.join(", ")
    : profileData.interests || "";

  const goals = Array.isArray(profileData.goals)
    ? profileData.goals.join(", ")
    : profileData.goals || "";

  const consulteeProfile = await prisma.consulteeProfile.upsert({
    where: { userId: id },
    create: {
      userId: id,
      education: profileData.education || "",
      occupation: profileData.occupation || "",
      aboutMe: profileData.aboutMe || "",
      preferredCommunicationMethod: (profileData.preferredCommunicationMethod ||
        "VIDEO") as ConsultationMode,
      preferredLanguage: profileData.preferredLanguage || "",
      specialRequirements: profileData.specialRequirements || "",
      interests: interests,
      goals: goals,
    },
    update: {
      education: profileData.education || "",
      occupation: profileData.occupation || "",
      aboutMe: profileData.aboutMe || "",
      preferredCommunicationMethod: (profileData.preferredCommunicationMethod ||
        "VIDEO") as ConsultationMode,
      preferredLanguage: profileData.preferredLanguage || "",
      specialRequirements: profileData.specialRequirements || "",
      interests: interests,
      goals: goals,
    },
  });

  return { consulteeProfileId: consulteeProfile.id };
}

async function updateStaffProfile(id: string, body: any) {
  const profileData = body.staffProfile?.create;
  if (!profileData) {
    throw new Error("Missing staff profile data");
  }

  const staffProfile = await prisma.staffProfile.upsert({
    where: { userId: id },
    create: {
      userId: id,
      department: profileData.department || "",
      position: profileData.position || "",
      permissions: profileData.permissions || {},
      responsibilities: profileData.responsibilities || {},
    },
    update: {
      department: profileData.department || "",
      position: profileData.position || "",
      permissions: profileData.permissions || {},
      responsibilities: profileData.responsibilities || {},
    },
  });

  return { staffProfileId: staffProfile.id };
}
