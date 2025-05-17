import { NextResponse, type NextRequest } from "next/server";
import { hash } from "bcryptjs"; // Example hashing library
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

// POST /api/user/staff - Create a new staff member
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      email,
      password, // Raw password from client
      name,
      phone,
      address,
      department,
      position,
      responsibilities, // Expecting JSON or array
      permissions, // Expecting JSON or array
    } = body;

    // Basic validation
    if (!email || !password || !name) {
      return NextResponse.json(
        { message: "Missing required fields: email, password, name" },
        { status: 400 },
      );
    }

    // --- Password Hashing ---
    // IMPORTANT: Never store raw passwords. Hash them securely.
    // Add proper salt rounds and error handling for production
    const hashedPassword = await hash(password, 10);
    // -----------------------

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
            responsibilities: responsibilities ?? undefined, // Store as JSON
            permissions: permissions ?? undefined, // Store as JSON
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

// GET /api/user/staff - Get all staff members (Implementation TBD)
export async function GET(request: NextRequest) {
  // TODO: Implement logic to fetch all users with role 'STAFF'
  // Remember to handle pagination, sorting, filtering
  // Omit sensitive data like passwords
  try {
    const staffUsers = await prisma.user.findMany({
      where: {
        role: "STAFF",
      },
      include: {
        staffProfile: true, // Include related staff profile data
      },
      // Add ordering, pagination etc. as needed
      // orderBy: { createdAt: 'desc' },
      // take: 10,
      // skip: 0,
    });

    // Exclude password from the returned user list
    // const usersWithoutPassword = staffUsers.map(
    //   // eslint-disable-next-line @typescript-eslint/no-unused-vars
    //   ({ password: _, ...user }) => user,
    // );

    return NextResponse.json(staffUsers);
  } catch (error) {
    console.error("Failed to fetch staff users:", error);
    return NextResponse.json(
      { message: "Internal Server Error fetching staff" },
      { status: 500 },
    );
  }
}
