/**
 * Admin User Detail API
 * GET /api/admin/users/[userId] - Get detailed user information
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

interface RouteParams {
  params: Promise<{ userId: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is admin or staff
    const currentUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (
      currentUser?.role !== UserRole.ADMIN &&
      currentUser?.role !== UserRole.STAFF
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { userId } = await params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        bio: true,
        email: true,
        phone: true,
        image: true,
        role: true,
        onboardingCompleted: true,
        createdAt: true,
        city: true,
        country: true,
        consultantProfile: {
          select: {
            id: true,

            description: true,
            isVerified: true,
            verificationStatus: true,
            domain: { select: { id: true, name: true } },
            specialization: true,
            experience: true,
          },
        },
        consulteeProfile: {
          select: {
            id: true,
            interests: true,
            preferredCommunicationMethod: true,
          },
        },
        staffProfile: {
          select: {
            id: true,
            department: true,
            position: true,
          },
        },
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ user });
  } catch (error) {
    console.error("Error fetching user details:", error);
    return NextResponse.json(
      { error: "Failed to fetch user details" },
      { status: 500 }
    );
  }
}
