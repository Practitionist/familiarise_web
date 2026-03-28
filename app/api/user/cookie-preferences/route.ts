import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth-helpers";
import { z } from "zod";

const UpdateCookiePreferencesSchema = z.object({
  analytics: z.boolean(),
  marketing: z.boolean(),
});

export async function GET() {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const prefs = await prisma.cookiePreference.findUnique({
      where: { userId: session.user.id },
    });

    if (!prefs) {
      return NextResponse.json(
        { data: { essential: true, analytics: false, marketing: false } },
        { status: 200 },
      );
    }

    return NextResponse.json({
      data: {
        essential: prefs.essential,
        analytics: prefs.analytics,
        marketing: prefs.marketing,
      },
    });
  } catch (error) {
    console.error("Error fetching cookie preferences:", error);
    return NextResponse.json(
      { error: "Failed to fetch cookie preferences" },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const body = await request.json();
    const result = UpdateCookiePreferencesSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }

    const prefs = await prisma.cookiePreference.upsert({
      where: { userId: session.user.id },
      update: {
        analytics: result.data.analytics,
        marketing: result.data.marketing,
      },
      create: {
        userId: session.user.id,
        analytics: result.data.analytics,
        marketing: result.data.marketing,
      },
    });

    return NextResponse.json({
      data: {
        essential: prefs.essential,
        analytics: prefs.analytics,
        marketing: prefs.marketing,
      },
    });
  } catch (error) {
    console.error("Error updating cookie preferences:", error);
    return NextResponse.json(
      { error: "Failed to update cookie preferences" },
      { status: 500 },
    );
  }
}
