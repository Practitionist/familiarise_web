import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import bcrypt from "bcrypt";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { token, password } = body;

    if (!token || !password) {
      return new NextResponse("Token and password are required", {
        status: 400,
      });
    }

    // Find user by the non-hashed token provided in the link
    // We need to find users whose token *hash* matches the *hash* of the provided token
    // This is tricky directly. Instead, we find users with a reset token set and where it hasn't expired.
    const usersWithToken = await prisma.user.findMany({
      where: {
        passwordResetToken: {
          not: null, // Ensure token exists
        },
        passwordResetExpires: {
          gte: new Date(), // Check if token is not expired
        },
      },
    });

    let user = null;
    for (const potentialUser of usersWithToken) {
      // Compare the provided token with the stored hash
      const tokenMatch = await bcrypt.compare(
        token,
        potentialUser.passwordResetToken!,
      );
      if (tokenMatch) {
        user = potentialUser;
        break;
      }
    }

    if (!user) {
      return new NextResponse("Invalid or expired token", { status: 400 });
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update user's password and clear reset token fields
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    return NextResponse.json({
      message: "Password has been reset successfully.",
    });
  } catch (error) {
    console.error("[RESET_PASSWORD_POST] Error:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
