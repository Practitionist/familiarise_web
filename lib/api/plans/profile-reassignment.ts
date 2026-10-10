import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

/** A plan may only move to a profile its editor owns; an absent or unchanged id passes. */
export async function refuseForeignProfileReassignment(
  userId: string,
  currentProfileId: string | null,
  requestedProfileId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!requestedProfileId || requestedProfileId === currentProfileId) {
    return null;
  }
  const target = await prisma.consultantProfile.findUnique({
    where: { id: requestedProfileId },
    select: { userId: true },
  });
  if (target?.userId === userId) return null;
  return NextResponse.json(
    { error: "You can only assign this plan to your own profile" },
    { status: 403 },
  );
}
