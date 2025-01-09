import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import Razorpay from "razorpay";
import { PaymentMetadata } from "@/types/checkout";

interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  notes: Record<string, string>;
}

interface RazorpayMock {
  orders: {
    create: (params: {
      amount: number;
      currency: string;
      notes: Record<string, string>;
      receipt: string;
    }) => Promise<RazorpayOrder>;
  };
}

const razorpay =
  process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_SECRET
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_SECRET,
      })
    : ({
        orders: {
          create: async () => ({
            id: "mock_order_id",
            amount: 1000,
            currency: "INR",
            status: "created",
            notes: {},
          }),
        },
      } as RazorpayMock);

export async function POST(req: Request) {
  try {
    const { amount, currency, metadata } = await req.json();

    // Create order
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Convert to paise
      currency,
      notes: metadata,
      receipt: `rcpt_${Date.now()}`,
    });

    return NextResponse.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      // Include Razorpay key for frontend
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Razorpay order error:", error);
    return NextResponse.json(
      { error: "Failed to create order" },
      { status: 500 },
    );
  }
}
