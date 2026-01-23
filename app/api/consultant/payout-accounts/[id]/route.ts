/**
 * Consultant Payout Account Management API
 * Update/Delete specific payout accounts
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/consultant/payout-accounts/[id]
 * Set as default account
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = await req.json();

    // Get consultant profile
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    // Verify account belongs to consultant
    const account = await prisma.payoutAccount.findUnique({
      where: { id },
    });

    if (!account || account.consultantProfileId !== consultantProfile.id) {
      return NextResponse.json(
        { error: "Payout account not found" },
        { status: 404 },
      );
    }

    // Handle setting as default (use transaction for atomicity)
    if (body.isDefault === true) {
      await prisma.$transaction(async (tx) => {
        // Unset other defaults
        await tx.payoutAccount.updateMany({
          where: {
            consultantProfileId: consultantProfile.id,
            isDefault: true,
          },
          data: { isDefault: false },
        });

        // Set this as default
        await tx.payoutAccount.update({
          where: { id },
          data: { isDefault: true },
        });
      });
    }

    const updatedAccount = await prisma.payoutAccount.findUnique({
      where: { id },
    });

    return NextResponse.json({
      success: true,
      account: updatedAccount,
    });
  } catch (error) {
    console.error("Error updating payout account:", error);
    return NextResponse.json(
      { error: "Failed to update payout account" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/consultant/payout-accounts/[id]
 * Remove a payout account
 */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Get consultant profile
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    // Verify account belongs to consultant
    const account = await prisma.payoutAccount.findUnique({
      where: { id },
    });

    if (!account || account.consultantProfileId !== consultantProfile.id) {
      return NextResponse.json(
        { error: "Payout account not found" },
        { status: 404 },
      );
    }

    // Don't allow deletion if there are pending payouts using this account
    const pendingPayouts = await prisma.payout.count({
      where: {
        consultantProfileId: consultantProfile.id,
        status: { in: ["PENDING", "APPROVED", "PROCESSING"] },
      },
    });

    if (pendingPayouts > 0) {
      return NextResponse.json(
        { error: "Cannot delete account with pending payouts" },
        { status: 400 },
      );
    }

    // Delete the account and reassign default if needed (use transaction for atomicity)
    await prisma.$transaction(async (tx) => {
      // Delete the account
      await tx.payoutAccount.delete({
        where: { id },
      });

      // If this was default, set another as default
      if (account.isDefault) {
        const anotherAccount = await tx.payoutAccount.findFirst({
          where: { consultantProfileId: consultantProfile.id },
          orderBy: { createdAt: "desc" },
        });

        if (anotherAccount) {
          await tx.payoutAccount.update({
            where: { id: anotherAccount.id },
            data: { isDefault: true },
          });
        }
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting payout account:", error);
    return NextResponse.json(
      { error: "Failed to delete payout account" },
      { status: 500 },
    );
  }
}
