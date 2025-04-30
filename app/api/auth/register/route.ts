import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import bcrypt from "bcrypt";
import { UserRole } from "@prisma/client"; // Import UserRole enum

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, email, password } = body;

    if (!name || !email || !password) {
      return new NextResponse("Missing name, email, or password", {
        status: 400,
      });
    }

    const exist = await prisma.user.findUnique({
      where: {
        email: email,
      },
    });

    if (exist) {
      return new NextResponse("User already exists", { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: UserRole.CONSULTEE, // Default role, adjust as needed
        // Initialize other required profiles or preferences if necessary
        cookiePreferences: {
          create: {},
        },
        notificationPreferences: {
          create: {},
        },
        consulteeProfile: {
          create: {}, // Automatically create a consultee profile
        },
      },
      // Include related models if needed upon creation
      include: {
        cookiePreferences: true,
        notificationPreferences: true,
        consulteeProfile: true,
      },
    });

    // Return only necessary user info, exclude password
    const { password: _, ...userWithoutPassword } = user;

    return NextResponse.json(userWithoutPassword);
  } catch (error) {
    console.error("[REGISTER_POST] Error:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
