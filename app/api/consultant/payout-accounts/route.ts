/**
 * Consultant Payout Accounts API
 * Manages bank accounts and UPI IDs for receiving payouts
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { PaymentGateway, PayoutAccountType } from "@prisma/client";
import { z } from "zod";
import {
  getRazorpayPayoutsService,
  isRazorpayPayoutsConfigured,
} from "@/lib/payments/payouts";

// Validation schemas
const createBankAccountSchema = z.object({
  provider: z.enum(["RAZORPAY", "STRIPE"]),
  accountType: z.enum(["BANK_ACCOUNT", "UPI"]),
  accountHolderName: z.string().min(2),
  bankName: z.string().optional(),
  accountNumber: z.string().optional(),
  ifscCode: z.string().optional(),
  upiId: z.string().optional(),
});

/**
 * GET /api/consultant/payout-accounts
 * List consultant's payout accounts
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get consultant profile
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      include: {
        payoutAccounts: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      accounts: consultantProfile.payoutAccounts,
    });
  } catch (error) {
    console.error("Error fetching payout accounts:", error);
    return NextResponse.json(
      { error: "Failed to fetch payout accounts" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/consultant/payout-accounts
 * Add a new payout account
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const data = createBankAccountSchema.parse(body);

    // Get consultant profile with user info
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      include: {
        user: true,
        payoutAccounts: true,
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 }
      );
    }

    // Validate based on account type
    if (data.accountType === "BANK_ACCOUNT") {
      if (!data.accountNumber || !data.ifscCode) {
        return NextResponse.json(
          { error: "Account number and IFSC code are required for bank accounts" },
          { status: 400 }
        );
      }
    } else if (data.accountType === "UPI") {
      if (!data.upiId) {
        return NextResponse.json(
          { error: "UPI ID is required for UPI accounts" },
          { status: 400 }
        );
      }
    }

    let razorpayContactId: string | undefined;
    let razorpayFundAccId: string | undefined;

    // Create RazorpayX contact and fund account if using Razorpay
    if (data.provider === "RAZORPAY" && isRazorpayPayoutsConfigured()) {
      const razorpayPayouts = getRazorpayPayoutsService();

      // Check if contact already exists
      const existingAccount = consultantProfile.payoutAccounts.find(
        (acc) => acc.razorpayContactId
      );

      if (existingAccount?.razorpayContactId) {
        razorpayContactId = existingAccount.razorpayContactId;
      } else {
        // Create new contact
        const contact = await razorpayPayouts.createContact({
          name: data.accountHolderName || consultantProfile.user.name || "Unknown",
          email: consultantProfile.user.email || "",
          type: "vendor",
          referenceId: consultantProfile.id,
        });
        razorpayContactId = contact.id;
      }

      // Create fund account
      if (data.accountType === "BANK_ACCOUNT") {
        const fundAccount = await razorpayPayouts.createFundAccount({
          contactId: razorpayContactId,
          accountType: "bank_account",
          bankAccount: {
            name: data.accountHolderName,
            ifsc: data.ifscCode!,
            accountNumber: data.accountNumber!,
          },
        });
        razorpayFundAccId = fundAccount.id;
      } else if (data.accountType === "UPI") {
        const fundAccount = await razorpayPayouts.createFundAccount({
          contactId: razorpayContactId,
          accountType: "vpa",
          vpa: {
            address: data.upiId!,
          },
        });
        razorpayFundAccId = fundAccount.id;
      }
    }

    // Set as default if first account
    const isFirst = consultantProfile.payoutAccounts.length === 0;

    // Create payout account record
    const payoutAccount = await prisma.payoutAccount.create({
      data: {
        consultantProfileId: consultantProfile.id,
        provider: data.provider as PaymentGateway,
        accountType: data.accountType as PayoutAccountType,
        accountHolderName: data.accountHolderName,
        bankName: data.bankName,
        accountNumberLast4: data.accountNumber?.slice(-4),
        ifscCode: data.ifscCode,
        upiId: data.upiId,
        razorpayContactId,
        razorpayFundAccId,
        isDefault: isFirst,
        isVerified: false, // Verification pending
      },
    });

    return NextResponse.json({
      success: true,
      account: payoutAccount,
    });
  } catch (error) {
    console.error("Error creating payout account:", error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid data", details: error.errors },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create payout account" },
      { status: 500 }
    );
  }
}
