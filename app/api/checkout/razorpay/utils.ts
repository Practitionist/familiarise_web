import Razorpay from "razorpay";

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  notes: Record<string, string>;
}

export interface RazorpayMock {
  orders: {
    create: (params: {
      amount: number;
      currency: string;
      notes: Record<string, string>;
      receipt?: string;
    }) => Promise<RazorpayOrder>;
    fetchPayments: (orderId: string) => Promise<{
      count: number;
      items: Array<{ id: string }>;
    }>;
  };
  payments: {
    refund: (
      paymentId: string,
      params?: { amount?: number },
    ) => Promise<{ id: string }>;
  };
}

// Mock implementations for testing
const mockRazorpay: RazorpayMock = {
  orders: {
    create: async () => ({
      id: "mock_order_id",
      amount: 1000,
      currency: "INR",
      status: "created",
      notes: {},
    }),
    fetchPayments: async () => ({
      count: 0,
      items: [],
    }),
  },
  payments: {
    refund: async () => ({ id: "mock_refund_id" }),
  },
};

export const razorpay = process.env.RAZORPAY_KEY_ID
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_SECRET!,
    })
  : (mockRazorpay as RazorpayMock);

// Helper function to verify Razorpay webhook signature
export function verifyRazorpayWebhook(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const crypto = require("crypto");
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  return expectedSignature === signature;
}

// Helper function to convert amount to paise
export function convertAmountToPaise(amount: number): number {
  return Math.round(amount * 100);
}

// Helper function to create order
export async function createRazorpayOrder({
  amount,
  metadata,
}: {
  amount: number;
  metadata: Record<string, string>;
}) {
  return razorpay.orders.create({
    amount: convertAmountToPaise(amount),
    currency: "INR",
    notes: metadata,
    receipt: `receipt_${Date.now()}`,
  });
}

// Helper function to fetch payments for an order
export async function fetchRazorpayPayments(orderId: string) {
  return razorpay.orders.fetchPayments(orderId);
}

// Helper function to create refund
export async function createRazorpayRefund(paymentId: string, amount?: number) {
  return razorpay.payments.refund(paymentId, {
    amount: amount ? convertAmountToPaise(amount) : undefined,
  });
}
