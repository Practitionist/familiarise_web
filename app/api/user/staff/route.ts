import { NextResponse, type NextRequest } from "next/server";
import { hash } from "bcryptjs"; // Example hashing library
import prisma from "@/lib/prisma";

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
        email,
        name,
        password: hashedPassword, // Store the hashed password
        phone,
        address,
        role: "STAFF", // Assign STAFF role
        staffProfile: {
          create: {
            department,
            position,
            // Prisma expects JsonNull for optional Json fields if not provided,
            // or the actual JSON structure if provided.
            responsibilities: responsibilities ?? undefined, // Store as JSON
            permissions: permissions ?? undefined, // Store as JSON
          },
        },
      },
      // Include the staff profile in the response
      include: {
        staffProfile: true,
      },
    });

    // Omit password from the returned user object
    const { password: _, ...userWithoutPassword } = newUser;

    return NextResponse.json(userWithoutPassword, { status: 201 });
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

    // Omit password from each user object before sending response
    const staffWithoutPasswords = staffUsers.map(
      ({ password: _, ...user }) => user,
    );

    return NextResponse.json(staffWithoutPasswords);
  } catch (error) {
    console.error("Error fetching staff:", error);
    return NextResponse.json(
      { message: "Internal Server Error fetching staff" },
      { status: 500 },
    );
  }
}
