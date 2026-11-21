import { z } from "zod";
import { razorpayNotesSchema } from "@/schemas/webhooks/razorpay";

const RAZORPAY_API = "https://api.razorpay.com/v1";

/** Razorpay's error body is `{ error: { code, description } }`; tolerate anything else. */
export async function razorpayErrorDescription(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { code?: unknown; description?: unknown };
    };
    const code = body?.error?.code;
    const description = body?.error?.description;
    return [code, description]
      .filter((v): v is string => typeof v === "string")
      .join(": ");
  } catch {
    return "";
  }
}

/** A Razorpay GET; `null` when the id is unknown (400 or 404). Throws when the gateway cannot answer. */
export async function razorpayGet(
  path: string,
  deadlineAt: number,
): Promise<unknown> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("Razorpay credentials not configured");
  }
  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const res = await fetch(`${RAZORPAY_API}/${path}`, {
    method: "GET",
    headers: { Authorization: `Basic ${credentials}` },
    signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
  });
  if (res.ok) return res.json();
  const description = await razorpayErrorDescription(res);
  if (res.status === 400 || res.status === 404) return null;
  throw new Error(`${res.status} ${description}`);
}

const paymentRefundsSchema = z.object({
  items: z.array(
    z
      .object({
        id: z.string(),
        amount: z.number().int().positive(),
        currency: z.string(),
        status: z.string(),
        notes: razorpayNotesSchema,
      })
      .passthrough(),
  ),
});

/**
 * Records every refund Razorpay holds against a capture (`GET /v1/payments/:id/refunds`) by its Razorpay id,
 * through the refund webhook's own handler, so the refundable balance nets them. Throws when one is not recorded.
 */
export async function recordGatewayRefunds(
  orderId: string,
  gatewayPaymentId: string,
  deadlineAt: number,
): Promise<void> {
  // Dynamic: the refund handler reaches back into booking.
  const { handleRefundCreated, DeferSignal } =
    await import("@/app/api/webhooks/utils");
  const body = await razorpayGet(
    `payments/${encodeURIComponent(gatewayPaymentId)}/refunds`,
    deadlineAt,
  );
  const { items } = paymentRefundsSchema.parse(body ?? { items: [] });
  for (const refund of items) {
    const recorded = await handleRefundCreated(
      refund.id,
      orderId,
      refund.amount,
      refund.currency,
      refund.status,
      gatewayPaymentId,
      refund.notes,
    );
    if (recorded instanceof DeferSignal) throw new Error(recorded.reason);
  }
}
