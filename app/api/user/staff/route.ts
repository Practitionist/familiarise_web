import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

// POST /api/user/staff - Create a new staff member (ADMIN only)
export async function POST(request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    // Only ADMIN can create staff members
    if (session.user.role !== "ADMIN") {
      return forbiddenResponse("Only administrators can create staff members");
    }

    const body = await request.json();
    const {
      email,
      password, // Raw password from client
      name,
      phone,
      address,
      department,
      position,
    } = body;

    // Basic validation
    if (!email || !password || !name) {
      return NextResponse.json(
        { message: "Missing required fields: email, password, name" },
        { status: 400 },
      );
    }

    // NOTE: Password hashing is handled by BetterAuth (lib/auth.ts).
    // The staff user.create below does not store a password directly.

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return NextResponse.json(
        { message: "User with this email already exists" },
        { status: 409 }, // Conflict
      );
    }

    // Create the user and staff profile within a transaction
    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        phone,
        role: UserRole.STAFF,
        address,
        staffProfile: {
          create: {
            department,
            position,
          },
        },
      },
      include: { staffProfile: true },
    });

    // Return the newly created staff user (excluding password)
    return NextResponse.json(newUser, { status: 201 });
  } catch (error) {
    console.error("Error creating staff:", error);
    // Provide a generic error message
    return NextResponse.json(
      { message: "Internal Server Error" },
      { status: 500 },
    );
  }
}

// GET /api/user/staff - Get all staff members (ADMIN/STAFF only)
export async function GET(_request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    // Only ADMIN/STAFF can list staff members
    if (!isPrivileged(session.user.role)) {
      return forbiddenResponse(
        "Only administrators and staff can view staff members",
      );
    }

    const staffUsers = await prisma.user.findMany({
      where: {
        role: "STAFF",
      },
      include: {
        staffProfile: true, // Include related staff profile data
      },
    });

    return NextResponse.json(staffUsers);
  } catch (error) {
    console.error("Failed to fetch staff users:", error);
    return NextResponse.json(
      { message: "Internal Server Error fetching staff" },
      { status: 500 },
    );
  }
}
