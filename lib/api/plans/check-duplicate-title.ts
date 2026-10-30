import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import { apiError } from "@/lib/errors/api-error";
import prisma from "@/lib/prisma";

export type DuplicateTitlePlanKind =
  "consultation" | "subscription" | "webinar" | "class";

const Query = z.object({
  title: z.string().trim().min(1),
  consultantProfileId: z.string().min(1),
  excludeId: z.string().optional(),
});

/** Whether one of the caller's own plans of this kind already uses the title. */
async function titleTaken(
  kind: DuplicateTitlePlanKind,
  where: {
    title: { equals: string; mode: "insensitive" };
    consultantProfileId: string;
    id?: { not: string };
  },
): Promise<boolean> {
  const select = { id: true } as const;
  switch (kind) {
    case "consultation":
      return !!(await prisma.consultationPlan.findFirst({ where, select }));
    case "subscription":
      return !!(await prisma.subscriptionPlan.findFirst({ where, select }));
    case "webinar":
      return !!(await prisma.webinarPlan.findFirst({ where, select }));
    case "class":
      return !!(await prisma.classPlan.findFirst({ where, select }));
  }
}

/**
 * GET `?title&consultantProfileId[&excludeId]` for the plan editors. Signed-in
 * only, and a consultant may ask only about their own plans (staff excepted).
 */
export async function checkDuplicateTitle(
  req: NextRequest,
  kind: DuplicateTitlePlanKind,
): Promise<NextResponse> {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { session } = auth;
  const parsed = Query.safeParse(
    Object.fromEntries(new URL(req.url).searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a title to check.", code: "INVALID_QUERY" },
      { status: 400 },
    );
  }
  const { title, consultantProfileId, excludeId } = parsed.data;
  if (
    consultantProfileId !== session.user.consultantProfileId &&
    !isPrivileged(session.user.role)
  ) {
    return NextResponse.json(
      {
        error: "You can only check titles of your own plans.",
        code: "FORBIDDEN",
      },
      { status: 403 },
    );
  }
  try {
    const isDuplicate = await titleTaken(kind, {
      title: { equals: title, mode: "insensitive" },
      consultantProfileId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    });
    return NextResponse.json({ isDuplicate }, { status: 200 });
  } catch (error) {
    return apiError({
      tag: `[check-duplicate-title.${kind}]`,
      error,
      userId: session.user.id,
      fallbackMessage: "We couldn't check that title. Try again.",
    });
  }
}
