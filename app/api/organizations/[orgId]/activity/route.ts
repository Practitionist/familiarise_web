/**
 * Org recent activity feed — lightweight union of recent events.
 *
 * GET — any active member. Returns the last N events across member joins,
 * payments, invoices, and invitations for the activity feed on the Overview page.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

interface ActivityItem {
  type: "member_joined" | "payment" | "invoice_generated" | "invitation_sent";
  description: string;
  timestamp: string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId);
    if (access.error) return access.error;

    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "5"), 20);

    // Fetch recent events in parallel
    const [members, payments, invoices, invitations] = await Promise.all([
      prisma.organizationMemberProfile.findMany({
        where: { organizationProfileId: access.org.id },
        include: {
          member: {
            include: { user: { select: { name: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 3,
      }),
      prisma.payment.findMany({
        where: {
          organizationProfileId: access.org.id,
          paymentStatus: "SUCCEEDED",
        },
        select: {
          amount: true,
          currency: true,
          createdAt: true,
          appointment: { select: { appointmentType: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 3,
      }),
      prisma.organizationInvoice.findMany({
        where: { organizationProfileId: access.org.id },
        select: {
          invoiceNumber: true,
          amount: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 2,
      }),
      prisma.invitation.findMany({
        where: { organizationId: orgId },
        select: { email: true, role: true, createdAt: true, status: true },
        orderBy: { createdAt: "desc" },
        take: 2,
      }),
    ]);

    // Merge into a unified activity feed
    const items: ActivityItem[] = [];

    for (const m of members) {
      items.push({
        type: "member_joined",
        description: `${m.member.user.name ?? "A user"} joined as ${m.role.replace("ORG_", "")}`,
        timestamp: m.createdAt.toISOString(),
      });
    }

    for (const p of payments) {
      const type = p.appointment?.appointmentType ?? "booking";
      const amountMajor = (p.amount / 100).toLocaleString("en-IN", {
        style: "currency",
        currency: p.currency,
      });
      items.push({
        type: "payment",
        description: `${amountMajor} ${type.toLowerCase()} booked`,
        timestamp: p.createdAt.toISOString(),
      });
    }

    for (const inv of invoices) {
      items.push({
        type: "invoice_generated",
        description: `Invoice ${inv.invoiceNumber} (${inv.status.toLowerCase()})`,
        timestamp: inv.createdAt.toISOString(),
      });
    }

    for (const inv of invitations) {
      items.push({
        type: "invitation_sent",
        description: `Invitation sent to ${inv.email} (${inv.status})`,
        timestamp: inv.createdAt.toISOString(),
      });
    }

    // Sort by timestamp descending, take top N
    items.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return NextResponse.json({ activity: items.slice(0, limit) });
  } catch (error) {
    console.error("[API /organizations/[orgId]/activity GET] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch activity" },
      { status: 500 },
    );
  }
}
