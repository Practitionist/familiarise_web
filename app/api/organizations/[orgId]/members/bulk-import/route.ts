/**
 * POST /api/organizations/[orgId]/members/bulk-import
 *
 * Wave-8 (#1230) — enterprise provisioning. Accepts a JSON array of
 * {email, name} entries and creates LEARNER memberships in bulk.
 * Replaces the 405 stub for the IMPORT use case only — bulk REMOVE and
 * bulk ROLE-CHANGE remain unsupported (anti-lockout risk).
 *
 * Per-entry results returned so a partial failure is visible without
 * retrying the whole batch. Seat cap enforced for unverified orgs.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { UNVERIFIED_ORG_SEAT_CAP, hasVerifiedDomain } from "@/lib/enterprise/governance";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { UserRole } from "@prisma/client";

const EntrySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(200),
});

const BodySchema = z.object({
  entries: z.array(EntrySchema).min(1).max(200),
});

interface RowResult {
  email: string;
  ok: boolean;
  membershipId?: string;
  error?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MAINTAINER",
    requireActive: false,
  });
  if (access.error) return access.error;
  if (
    access.org.status === "SUSPENDED" ||
    access.org.status === "DEACTIVATED"
  ) {
    return NextResponse.json(
      { error: "ORG_NOT_ACTIVE" },
      { status: 409 },
    );
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const entries = parsed.data.entries;

  // Dedupe within batch
  const seen = new Set<string>();
  const deduped = entries.filter((e) => {
    if (seen.has(e.email)) return false;
    seen.add(e.email);
    return true;
  });

  const results: RowResult[] = [];
  let imported = 0;
  let failed = 0;

  for (const entry of deduped) {
    try {
      // Find or create User
      let user = await prisma.user.findUnique({
        where: { email: entry.email },
        select: { id: true },
      });
      if (!user) {
        user = await prisma.user.create({
          data: { email: entry.email, name: entry.name },
          select: { id: true },
        });
      }

      // Check existing membership
      const existing = await prisma.membership.findUnique({
        where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
        select: { id: true, status: true },
      });
      if (existing && existing.status !== "REMOVED") {
        results.push({ email: entry.email, ok: false, error: "Already a member" });
        continue;
      }

      // Seat cap for unverified domains
      const verified = await hasVerifiedDomain(prisma, orgId);
      if (!verified) {
        const activeCount = await prisma.membership.count({
          where: { organizationId: orgId, status: "ACTIVE" },
        });
        if (activeCount >= UNVERIFIED_ORG_SEAT_CAP) {
          results.push({
            email: entry.email,
            ok: false,
            error: `Seat cap (${UNVERIFIED_ORG_SEAT_CAP}) reached — verify a domain to add more`,
          });
          continue;
        }
      }

      if (existing) {
        // Reactivate REMOVED row via CAS
        const claimed = await prisma.membership.updateMany({
          where: { id: existing.id, status: "REMOVED", organizationId: orgId },
          data: { status: "ACTIVE" },
        });
        if (claimed.count === 0) {
          results.push({ email: entry.email, ok: false, error: "Could not reactivate" });
          continue;
        }
        results.push({ email: entry.email, ok: true, membershipId: existing.id });
        imported++;
        continue;
      }

      // Create new LEARNER membership
      const created = await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: orgId,
          role: "LEARNER",
          status: "ACTIVE",
        },
      });
      await prisma.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          targetMembershipId: created.id,
          category: "MEMBER",
          action: AUDIT_ACTIONS.MEMBER.MEMBER_ADDED,
          description: `Bulk-imported ${entry.email} as LEARNER`,
        },
      });
      results.push({ email: entry.email, ok: true, membershipId: created.id });
      imported++;
    } catch {
      results.push({ email: entry.email, ok: false, error: "Internal error" });
    }
  }

  return NextResponse.json({ imported, failed, results }, { status: 200 });
}
