import * as Sentry from "@sentry/nextjs";
export interface LemonSqueezyCheckout {
  data: {
    id: string;
    type: string;
    attributes: {
      url: string;
      status: string;
      custom_price: number;
    };
  };
}

export interface LemonSqueezyMock {
  checkouts: {
    create: (params: {
      data: {
        type: string;
        attributes: {
          custom_price: number;
          product_options: {
            name: string;
            description: string;
          };
          checkout_data: {
            custom: Record<string, string>;
          };
          success_url: string;
          cancel_url: string;
        };
      };
    }) => Promise<LemonSqueezyCheckout>;
  };
}

// Mock implementation for testing
const mockLemonSqueezy: LemonSqueezyMock = {
  checkouts: {
    create: async () => ({
      data: {
        id: "mock_checkout_id",
        type: "checkout",
        attributes: {
          url: "https://mock.checkout.url",
          status: "pending",
          custom_price: 1000,
        },
      },
    }),
  },
};

// Helper function to verify Lemon Squeezy webhook signature
export function verifyLemonSqueezyWebhook(
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
export async function createLemonSqueezyCheckout({
  amount,
  metadata,
  productDetails,
  urls,
}: {
  amount: number;
  metadata: Record<string, string>;
  productDetails: {
    name: string;
    description: string;
  };
  urls: {
    success: string;
    cancel: string;
  };
}): Promise<LemonSqueezyCheckout> {
  const response = await fetch(
    `${process.env.LEMON_SQUEEZY_API_URL}/checkouts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {
          type: "checkouts",
          attributes: {
            custom_price: convertAmountToCents(amount),
            product_options: {
              name: productDetails.name,
              description: productDetails.description,
            },
            checkout_data: {
              custom: metadata,
            },
            success_url: urls.success,
            cancel_url: urls.cancel,
          },
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error("Failed to create Lemon Squeezy checkout");
  }

  return response.json();
}

// Helper function to parse webhook event
export function parseLemonSqueezyWebhook(body: string) {
  const event = JSON.parse(body);
  return {
    type: event.meta.event_name,
    data: event.data,
  };
}
