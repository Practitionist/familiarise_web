import { NextResponse, type NextRequest } from "next/server";
import { hash } from "bcryptjs"; // For password updates
import prisma from "@/lib/prisma"; // Use central instance
import { Prisma } from "@prisma/client";

// GET /api/user/staff/{id} - Fetch a single staff member by ID
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = params.id;

  try {
    const staffUser = await prisma.user.findUnique({
      where: {
        id,
        role: "STAFF", // Ensure we only fetch staff members
      },
      include: {
        staffProfile: true, // Include related staff profile data
        notificationPreferences: true, // Include notification preferences
        cookiePreferences: true, // Include cookie preferences
      },
    });

    if (!staffUser) {
      return NextResponse.json(
        { message: "Staff member not found" },
        { status: 404 },
      );
    }

    // Omit password from the returned user object
    const { password: _, ...userWithoutPassword } = staffUser;

    return NextResponse.json(userWithoutPassword);
  } catch (error) {
    console.error("Error fetching staff member:", error);
    return NextResponse.json(
      { message: "Internal Server Error fetching staff member" },
      { status: 500 },
    );
  }
}

// PUT /api/user/staff/{id} - Update a staff member by ID
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = params.id;

  try {
    const body = await request.json();
    const {
      email,
      password, // Optional: Only include if changing password
      name,
      phone,
      address,
      currentTimezone,
      onboardingCompleted,
      department,
      position,
      responsibilities, // Expecting JSON or array
      permissions, // Expecting JSON or array
      // Add other fields from User or StaffProfile as needed
      // Preference fields
      allNotifications,
      mentions,
      directMessages,
      updates,
      analytics,
      marketing,
    } = body;

    // Prepare data for update
    const userData: Prisma.UserUpdateInput = {};
    const staffProfileData: Prisma.StaffProfileUpdateInput = {};
    const notificationPrefsData: Prisma.NotificationPreferenceUpdateInput = {};
    const cookiePrefsData: Prisma.CookiePreferenceUpdateInput = {};

    if (email) userData.email = email;
    if (name) userData.name = name;
    if (phone) userData.phone = phone;
    if (address) userData.address = address;
    if (currentTimezone) userData.currentTimezone = currentTimezone;
    if (typeof onboardingCompleted === "boolean")
      userData.onboardingCompleted = onboardingCompleted;

    // Handle password update separately
    if (password) {
      userData.password = await hash(password, 10); // Hash new password
    }

    if (department) staffProfileData.department = department;
    if (position) staffProfileData.position = position;
    // Need to handle JSON fields potentially being null or undefined
    if (responsibilities !== undefined)
      staffProfileData.responsibilities = responsibilities;
    if (permissions !== undefined) staffProfileData.permissions = permissions;

    // --- Prepare Preferences Data ---
    // Notification Preferences
    if (typeof allNotifications === "boolean")
      notificationPrefsData.allNotifications = allNotifications;
    if (typeof mentions === "boolean")
      notificationPrefsData.mentions = mentions;
    if (typeof directMessages === "boolean")
      notificationPrefsData.directMessages = directMessages;
    if (typeof updates === "boolean") notificationPrefsData.updates = updates;

    // Cookie Preferences (essential is usually not user-editable)
    if (typeof analytics === "boolean") cookiePrefsData.analytics = analytics;
    if (typeof marketing === "boolean") cookiePrefsData.marketing = marketing;
    // ---------------------------------

    // Check if there's any data to update
    const hasUserData = Object.keys(userData).length > 0;
    const hasStaffProfileData = Object.keys(staffProfileData).length > 0;
    const hasNotificationPrefsData =
      Object.keys(notificationPrefsData).length > 0;
    const hasCookiePrefsData = Object.keys(cookiePrefsData).length > 0;

    // Construct the update payload conditionally
    const updateData: Prisma.UserUpdateArgs["data"] = {
      ...(hasUserData && userData),
      ...(hasStaffProfileData && {
        staffProfile: { update: staffProfileData },
      }),
      ...(hasNotificationPrefsData && {
        notificationPreferences: { update: notificationPrefsData },
      }),
      // Cookie prefs might be created if they don't exist, update otherwise
      // Using upsert might be safer if preferences might not exist initially
      ...(hasCookiePrefsData && {
        cookiePreferences: { update: cookiePrefsData },
      }),
    };

    // Prevent empty update
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { message: "No changes detected" },
        { status: 400 },
      );
    }

    // Update the user and potentially related records
    const updatedUser = await prisma.user.update({
      where: {
        id,
        role: "STAFF", // Ensure we only update staff members
      },
      data: updateData,
      include: {
        staffProfile: true, // Include updated profile data
        notificationPreferences: true,
        cookiePreferences: true,
      },
    });

    // Omit password from the returned user object
    const { password: _, ...userWithoutPassword } = updatedUser;

    return NextResponse.json(userWithoutPassword);
  } catch (error) {
    console.error("Error updating staff member:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // Handle specific Prisma errors, e.g., record not found
      if (error.code === "P2025") {
        return NextResponse.json(
          { message: "Staff member not found" },
          { status: 404 },
        );
      }
      // Handle unique constraint errors (e.g., email already exists)
      if (error.code === "P2002" && error.meta?.target === "users_email_key") {
        return NextResponse.json(
          { message: "Email already in use" },
          { status: 409 },
        );
      }
    }
    return NextResponse.json(
      { message: "Internal Server Error updating staff member" },
      { status: 500 },
    );
  }
}

// DELETE /api/user/staff/{id} - Delete a staff member by ID
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = params.id;

  try {
    await prisma.user.delete({
      where: {
        id,
        role: "STAFF", // Ensure we only delete staff members
      },
    });

    // Return 204 No Content for successful deletion
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("Error deleting staff member:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // Handle specific Prisma errors, e.g., record not found
      if (error.code === "P2025") {
        return NextResponse.json(
          { message: "Staff member not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { message: "Internal Server Error deleting staff member" },
      { status: 500 },
    );
  }
}
