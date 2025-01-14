export interface XflowCheckoutSession {
  id: string;
  url: string;
  status: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}

export interface XflowMock {
  checkoutSessions: {
    create: (params: {
      amount: number;
      currency: string;
      customer: {
        id: string;
        email: string;
      };
      metadata: Record<string, string>;
      success_url: string;
      cancel_url: string;
      line_items: Array<{
        name: string;
        description: string;
        amount: number;
        currency: string;
        quantity: number;
      }>;
    }) => Promise<XflowCheckoutSession>;
  };
}

// Mock implementation for testing
const mockXflow: XflowMock = {
  checkoutSessions: {
    create: async () => ({
      id: "mock_session_id",
      url: "https://mock.checkout.url",
      status: "pending",
      amount: 1000,
      currency: "usd",
      metadata: {},
    }),
  },
};

// Helper function to verify Xflow webhook signature
export function verifyXflowWebhook(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const crypto = require("crypto");
  const hmac = crypto.createHmac("sha256", secret);
  const digest = hmac.update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

// Helper function to convert amount to cents
export function convertAmountToCents(amount: number): number {
  return Math.round(amount * 100);
}

// Helper function to create checkout session
export async function createXflowCheckoutSession({
  amount,
  metadata,
  customer,
  productDetails,
  urls,
}: {
  amount: number;
  metadata: Record<string, string>;
  customer: {
    id: string;
    email: string;
  };
  productDetails: {
    name: string;
    description: string;
  };
  urls: {
    success: string;
    cancel: string;
  };
}): Promise<XflowCheckoutSession> {
  const response = await fetch(
    `${process.env.XFLOW_API_URL}/checkout-sessions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.XFLOW_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: convertAmountToCents(amount),
        currency: "usd",
        customer,
        metadata,
        success_url: urls.success,
        cancel_url: urls.cancel,
        line_items: [
          {
            name: productDetails.name,
            description: productDetails.description,
            amount: convertAmountToCents(amount),
            currency: "usd",
            quantity: 1,
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || "Failed to create Xflow checkout");
  }

  return response.json();
}

// Helper function to parse webhook event
export function parseXflowWebhook(body: string) {
  const event = JSON.parse(body);
  return {
    type: event.type,
    data: event.data,
  };
}
