/**
 * Staff Reports Export API
 * Export reports as CSV
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/reports/export
 * Export ticket data as CSV
 */
export async function GET(req: NextRequest) {
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

    const { searchParams } = new URL(req.url);
    const days = parseInt(searchParams.get("days") || "30");
    const type = searchParams.get("type") || "tickets";

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    if (type === "tickets") {
      const tickets = await prisma.supportTicket.findMany({
        where: {
          createdAt: { gte: startDate },
        },
        include: {
          user: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      // Generate CSV
      const headers = [
        "Ticket ID",
        "Title",
        "Status",
        "Priority",
        "Issue Type",
        "Category",
        "User Name",
        "User Email",
        "Assigned To",
        "Created At",
        "Updated At",
      ];

      const rows = tickets.map((ticket) => [
        ticket.id,
        `"${ticket.title.replace(/"/g, '""')}"`,
        ticket.status,
        ticket.priority,
        ticket.issueType || "",
        ticket.category || "",
        ticket.user.name || "",
        ticket.user.email || "",
        ticket.assignedToId || "",
        ticket.createdAt.toISOString(),
        ticket.updatedAt.toISOString(),
      ]);

      const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join(
        "\n"
      );

      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="tickets-export-${new Date().toISOString().split("T")[0]}.csv"`,
        },
      });
    }

    return NextResponse.json({ error: "Invalid export type" }, { status: 400 });
  } catch (error) {
    console.error("Error exporting reports:", error);
    return NextResponse.json(
      { error: "Failed to export reports" },
      { status: 500 }
    );
  }
}
