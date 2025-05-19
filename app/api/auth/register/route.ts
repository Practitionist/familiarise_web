import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import bcrypt from "bcrypt";
import { UserRole } from "@prisma/client"; // Import UserRole enum
import { sendWelcomeEmail } from "@/lib/email";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, email, password } = body;

    if (!name || !email || !password) {
      return new NextResponse("Missing name, email, or password", {
        status: 400,
      });
    }

    // Check if user exists with this email
    const existingUser = await prisma.user.findUnique({
      where: {
        email: email,
      },
      include: {
        accounts: true, // Include accounts to check if user exists via OAuth
        consulteeProfile: true, // Include consulteeProfile to check if it exists
      },
    });

    // If user exists but they have OAuth accounts and no password
    // This means they previously signed in with OAuth but now want to add password credentials
    if (existingUser) {
      // If user already has a password, return error
      if (existingUser.password) {
        return new NextResponse(
          "An account with this email already exists. Please sign in instead.",
          { status: 409 },
        );
      }

      // If user exists via OAuth only (has accounts but no password)
      if (existingUser.accounts.length > 0 && !existingUser.password) {
        try {
          // Add password credentials to existing OAuth user
          const hashedPassword = await bcrypt.hash(password, 10);

          // Update the user with the password
          const updatedUser = await prisma.user.update({
            where: { id: existingUser.id },
            data: {
              password: hashedPassword,
              // Update name if needed
              name: existingUser.name || name,
              // Do not attempt to modify the profile relationships here
            },
          });

          // Check if consulteeProfile needs to be created
          if (!existingUser.consulteeProfile) {
            await prisma.consulteeProfile.create({
              data: {
                userId: existingUser.id,
              },
            });
          }

          // Check if preference records exist and create if not
          const cookiePref = await prisma.cookiePreference.findUnique({
            where: { userId: existingUser.id },
          });

          if (!cookiePref) {
            await prisma.cookiePreference.create({
              data: { userId: existingUser.id },
            });
          }

          const notifPref = await prisma.notificationPreference.findUnique({
            where: { userId: existingUser.id },
          });

          if (!notifPref) {
            await prisma.notificationPreference.create({
              data: { userId: existingUser.id },
            });
          }

          // Return user without password
          const { password: _, ...userWithoutPassword } = updatedUser;
          return NextResponse.json({
            ...userWithoutPassword,
            message:
              "Successfully linked your email and password to your existing account",
          });
        } catch (error) {
          console.error("[REGISTER_POST] Account linking error:", error);
          return NextResponse.json(
            {
              error:
                "We couldn't link your password to your existing account. Please try signing in with your social account instead.",
            },
            { status: 400 },
          );
        }
      } else {
        return NextResponse.json(
          {
            error:
              "An account with this email already exists. Please sign in instead.",
          },
          { status: 409 },
        );
      }
    }

    // If no user exists, create a new one
    try {
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

      // Send welcome email to the new user
      try {
        console.log("Sending welcome email to:", email);
        const emailResult = await sendWelcomeEmail({
          email,
          name,
        });

        if (!emailResult.success) {
          console.error(
            "[REGISTER_POST] Welcome email failed:",
            emailResult.error,
          );
        } else {
          console.log(
            "[REGISTER_POST] Welcome email sent successfully:",
            emailResult.data,
          );
        }
      } catch (emailError) {
        console.error("[REGISTER_POST] Welcome email error:", emailError);
        // Continue despite email failure - don't block registration
      }

      // Return only necessary user info, exclude password
      const { password: _, ...userWithoutPassword } = user;

      return NextResponse.json(userWithoutPassword);
    } catch (error) {
      console.error("[REGISTER_POST] User creation error:", error);
      return NextResponse.json(
        {
          error: "We couldn't create your account. Please try again later.",
        },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error("[REGISTER_POST] Error:", error);
    return NextResponse.json(
      {
        error: "Something went wrong. Please try again later.",
      },
      { status: 500 },
    );
  }
}
