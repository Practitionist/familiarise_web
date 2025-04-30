import { sendPasswordResetEmail } from "@/lib/email";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { email } = body;

    if (!email) {
      return new NextResponse("Email is required", { status: 400 });
    }

    await sendPasswordResetEmail(email);

    // Always return a success response to prevent email enumeration
    return NextResponse.json({
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });
  } catch (error) {
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
