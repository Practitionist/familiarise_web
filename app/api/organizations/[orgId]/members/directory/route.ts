/**
 * GET /api/organizations/[orgId]/members/directory
 *
 * #1527 decision 3 — the names-only people list every active member may
 * read: name, avatar and role label of ACTIVE members, nothing else (no
 * email, status or usage). Operators with `members.read` use the full
 * roster route beside this one. Search matches names only, so the endpoint
 * can't be used to test whether an email address belongs to the org. `role`
 * narrows to one role label, which the response already carries (#1527).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { MemberRoleSchema } from "@/lib/labels/org-labels";

const QuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  role: MemberRoleSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "members.directory",
  });
  if (access.error) return access.error;

  const parsed = QuerySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { q, role, page, perPage } = parsed.data;

  const where = {
    organizationId: orgId,
    status: "ACTIVE" as const,
    ...(role && { role }),
    ...(q && { user: { name: { contains: q, mode: "insensitive" as const } } }),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.membership.count({ where }),
    prisma.membership.findMany({
      where,
      select: {
        id: true,
        role: true,
        user: { select: { name: true, image: true } },
      },
      orderBy: { user: { name: "asc" } },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  return NextResponse.json({
    data: rows.map((r) => ({
      id: r.id,
      role: r.role,
      name: r.user.name,
      image: r.user.image,
    })),
    total,
    page,
    perPage,
  });
}
