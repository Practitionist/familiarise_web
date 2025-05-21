import * as Sentry from "@sentry/nextjs";
import { sendPasswordResetEmail } from "@/lib/email";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import bcrypt from "bcrypt";
import crypto from "crypto";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { email } = body;

    if (!email) {
      return new NextResponse("Email is required", { status: 400 });
    }

    // Find the user by email
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true },
    });

    // Only proceed if user exists (but don't expose this information in the response)
    if (user) {
      // Generate random token
      const resetToken = crypto.randomBytes(32).toString("hex");
      // Hash the token for security
      const hashedToken = await bcrypt.hash(resetToken, 10);

      // Set token expiration (30 minutes from now)
      const expiryDate = new Date();
      expiryDate.setMinutes(expiryDate.getMinutes() + 30);

      // Update user with reset token and expiry
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetToken: hashedToken,
          passwordResetExpires: expiryDate,
        },
      });

      // Send reset email with the plain text token (not the hash)
      try {
        console.log(`Sending password reset email to: ${email}`);
        const emailResult = await sendPasswordResetEmail({
          email,
          name: user.name ?? "User",
          token: resetToken,
        });

        if (!emailResult.success) {
          console.error(
            "[FORGOT_PASSWORD_POST] Email sending failed:",
            emailResult.error,
          );
        } else {
          console.log(
            "[FORGOT_PASSWORD_POST] Password reset email sent successfully",
          );
        }
      } catch (emailError) {
        Sentry.captureException(emailError);
        console.error("[FORGOT_PASSWORD_POST] Email error:", emailError);
        // Continue despite email failure - don't block the process
      }
    }

    // Always return a success response to prevent email enumeration
    return NextResponse.json({
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error("[FORGOT_PASSWORD_POST] Error:", error);
    // Return a generic error message even if email sending fails internally
    return NextResponse.json({
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });
    // Or, if you want to indicate a server error:
    // return new NextResponse("Internal Server Error", { status: 500 });
  }
}
