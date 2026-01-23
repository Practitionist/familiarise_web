/**
 * Staff Help Contacts API
 * Returns hardcoded support contacts (could be moved to DB if needed)
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

// Support contacts - could be moved to DB/config later
const SUPPORT_CONTACTS = [
  {
    name: "IT Support",
    availability: "24/7",
    email: "it-support@familiarise.com",
    phone: "+91 1800-XXX-XXXX",
    description: "Technical issues, system access",
  },
  {
    name: "HR Department",
    availability: "Mon-Fri 9AM-6PM IST",
    email: "hr@familiarise.com",
    phone: "+91 1800-XXX-XXXY",
    description: "Leave requests, policies, training",
  },
  {
    name: "Admin Escalation",
    availability: "24/7 for urgent issues",
    email: "admin-escalation@familiarise.com",
    phone: "+91 1800-XXX-XXXZ",
    description: "Urgent escalations, high-priority issues",
  },
  {
    name: "Finance Team",
    availability: "Mon-Fri 10AM-5PM IST",
    email: "finance@familiarise.com",
    phone: "+91 1800-XXX-XXXW",
    description: "Refunds, payouts, billing queries",
  },
];

/**
 * GET /api/staff/help/contacts
 * Get support contact information
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ contacts: SUPPORT_CONTACTS });
  } catch (error) {
    console.error("Error fetching contacts:", error);
    return NextResponse.json(
      { error: "Failed to fetch contacts" },
      { status: 500 }
    );
  }
}
