import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { Prisma, UserRole } from "@prisma/client";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { pageNumberSchema } from "@/lib/backoffice/list-paging";

const PAGE_SIZE = 20;

const querySchema = z.object({
  page: pageNumberSchema,
  // "all" or an unknown role reads as no role filter.
  role: z.nativeEnum(UserRole).optional().catch(undefined),
  search: z.string().trim().max(200).optional().catch(undefined),
  orgId: z.string().min(1).max(64).optional().catch(undefined),
});

/** GET /api/admin/users — one page of the user directory, newest first. */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("users.read");
    if (auth.error) return auth.error;

    const searchParams = req.nextUrl.searchParams;
    const { page, role, search, orgId } = querySchema.parse({
      page: searchParams.get("page") ?? undefined,
      role: searchParams.get("role") ?? undefined,
      search: searchParams.get("search") || undefined,
      orgId: searchParams.get("orgId") || undefined,
    });

    const where: Prisma.UserWhereInput = {
      ...(role ? { role } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
      // Users with an ACTIVE membership at one org, for "all members of Acme".
      ...(orgId
        ? { memberships: { some: { organizationId: orgId, status: "ACTIVE" } } }
        : {}),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
          onboardingCompleted: true,
          createdAt: true,
        },
        // Newest first; the id breaks a tie so a page never repeats a user.
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.user.count({ where }),
    ]);

    return NextResponse.json({
      users,
      total,
      page,
      totalPages: Math.ceil(total / PAGE_SIZE),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Error fetching users:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
