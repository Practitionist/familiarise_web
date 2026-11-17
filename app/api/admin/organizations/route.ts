/**
 * GET /api/admin/organizations
 *
 * Platform-admin view of all organizations — filterable by status,
 * searchable by name/email. Used by the admin org management page to
 * surface PENDING_VERIFICATION orgs for review and allow admins to
 * verify, suspend, or reactivate without needing DB access.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { OrgStatus } from "@prisma/client";
import { readPageParams } from "@/lib/backoffice/list-paging";
import { ORG_AWAITING_VERIFICATION_WHERE } from "@/lib/backoffice/queue-predicates";

const OrgStatusSchema = z.nativeEnum(OrgStatus).optional();

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("organizations.manage");
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const search = url.searchParams.get("search")?.trim() ?? "";
  const { page, limit, skip } = readPageParams(url.searchParams, 25);
  const statusFilter = OrgStatusSchema.safeParse(
    url.searchParams.get("status") ?? undefined,
  );
  if (!statusFilter.success) {
    return NextResponse.json(
      { error: "Unknown organization status", code: "INVALID_STATUS" },
      { status: 400 },
    );
  }

  // #1527 — `queue=verification` is the Verification page's Organizations
  // tab and its nav badge: the same predicate.
  const verificationQueue = url.searchParams.get("queue") === "verification";
  const where: Prisma.OrganizationWhereInput = {
    ...(verificationQueue ? ORG_AWAITING_VERIFICATION_WHERE : {}),
    ...(!verificationQueue && statusFilter.data
      ? { status: statusFilter.data }
      : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            {
              billingEmail: { contains: search, mode: "insensitive" as const },
            },
            { slug: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, organizations] = await Promise.all([
    prisma.organization.count({ where }),
    prisma.organization.findMany({
      relationLoadStrategy: "join",
      where,
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        canSponsor: true,
        canHost: true,
        billingEmail: true,
        createdAt: true,
        billingAccount: {
          select: { id: true, fundingSource: true },
        },
        _count: {
          select: {
            memberships: true,
            contracts: true,
          },
        },
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }, { id: "asc" }],
      skip,
      take: limit,
    }),
  ]);

  return NextResponse.json({
    data: organizations,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
}
