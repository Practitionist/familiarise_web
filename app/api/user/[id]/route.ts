import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import authOptions from "../../auth/[...nextauth]/options";
import { UserRole } from "@prisma/client";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    // const session = await getServerSession(authOptions);
    // if (!session || (session.user.id !== id && session.user.role !== 'ADMIN')) {
    //   return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // }

    const user = await prisma.user.findUnique({
      where: { id: id },
      include: {
        // Professional background at User level
        workExperiences: {
          orderBy: [{ isCurrent: "desc" }, { startDate: "desc" }],
        },
        education: {
          orderBy: { endYear: "desc" },
        },
        certifications: {
          orderBy: { issueDate: "desc" },
        },
        consultantProfile: {
          select: {
            id: true,
            description: true,
            experience: true,
            rating: true,
            domainId: true,
            // New fields
            headline: true,
            websiteUrl: true,
            twitterUrl: true,
            githubUrl: true,
            videoIntroUrl: true,
            languages: true,
            toolsAndTechnologies: true,
            mentoringStyle: true,
            sessionTypes: true,
            profileCompletionPercentage: true,
            isVerified: true,
            totalMenteesHelped: true,
          },
        },
        consulteeProfile: {
          select: {
            id: true,
            occupation: true,
            aboutMe: true,
            preferredCommunicationMethod: true,
            preferredLanguage: true,
            goals: true,
            // New fields
            careerStage: true,
            currentCompany: true,
            industry: true,
            skillsToDevelop: true,
            linkedinUrl: true,
            budgetPreference: true,
          },
        },
        staffProfile: {
          select: {
            id: true,
            department: true,
            position: true,
            permissions: true,
            responsibilities: true,
            // New fields
            employeeId: true,
            hireDate: true,
            reportsTo: true,
            skills: true,
            workSchedule: true,
          },
        },
        adminProfile: {
          select: {
            id: true,
            adminLevel: true,
            accessScope: true,
            assignedRegions: true,
            notes: true,
          },
        },
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ data: user }, { status: 200 });
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error: ", error.stack);
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "An error occurred while fetching the user",
      },
      { status: 500 },
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const session = await getServerSession(authOptions);
    if (!session || (session.user.id !== id && session.user.role !== "ADMIN")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const {
      name,
      email,
      image,
      phone,
      address,
      onboardingCompleted,
      role,
      currentTimezone,
      // New user fields
      dateOfBirth,
      gender,
      city,
      country,
      linkedinUrl,
      bio,
    } = body;

    // Input validation
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "Invalid email format" },
        { status: 400 },
      );
    }

    if (role && !Object.values(UserRole).includes(role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }

    // Validate bio length if provided
    if (bio && bio.length > 160) {
      return NextResponse.json(
        { error: "Bio must be 160 characters or less" },
        { status: 400 },
      );
    }

    const updatedUser = await prisma.user.update({
      where: { id: id },
      data: {
        name,
        email,
        image,
        phone,
        address,
        onboardingCompleted,
        role: role as UserRole,
        timezone: currentTimezone,
        // New user fields
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
        gender,
        city,
        country,
        linkedinUrl,
        bio,
      },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        phone: true,
        address: true,
        onboardingCompleted: true,
        role: true,
        timezone: true,
        // New fields
        dateOfBirth: true,
        gender: true,
        city: true,
        country: true,
        linkedinUrl: true,
        bio: true,
      },
    });

    return NextResponse.json({ data: updatedUser }, { status: 200 });
  } catch (error) {
    console.error("Error updating user:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the user" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { id: id } });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    await prisma.user.delete({ where: { id: id } });

    return NextResponse.json(
      { message: "User deleted successfully" },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting user:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the user" },
      { status: 500 },
    );
  }
}
