/**
 * Invoice Details API
 * Get specific invoice by ID or invoice number
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { getInvoiceById, getInvoiceByNumber } from "@/lib/payments/payouts";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/invoices/[id]
 * Get invoice by ID or invoice number
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Try to find by ID first, then by invoice number
    let invoice = await getInvoiceById(id);
    if (!invoice) {
      invoice = await getInvoiceByNumber(id);
    }

    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    // Check authorization - user can only view their own invoices
    // unless they're an admin
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (
      invoice.payment?.user?.email !== session.user.email &&
      user?.role !== "ADMIN"
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Parse items from JSON
    const invoiceData = {
      ...invoice,
      items: invoice.items as Array<{
        description: string;
        quantity: number;
        unitPrice: number;
        amount: number;
        hsnCode?: string;
      }>,
    };

    return NextResponse.json({ invoice: invoiceData });
  } catch (error) {
    console.error("Error fetching invoice:", error);
    return NextResponse.json(
      { error: "Failed to fetch invoice" },
      { status: 500 },
    );
  }
}
