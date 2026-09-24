"use client";

import { useState } from "react";
import { loadScript } from "@/app/checkout/plans/utils";
import { buildCheckoutOptions } from "@/lib/payments/client/checkout-options";

/**
 * Minimal replay-purchase checkout (#366). Mints the order via
 * /api/recordings/[id]/purchase, then opens Razorpay Checkout with that
 * order_id. Entitlement settles server-side from the capture webhook — the
 * success handler here only refreshes UI.
 */

interface BuyButtonProps {
  recordingId: string;
  // Kept for the caller's contract; the checkout amount always comes from
  // the minted order (body.data.amount), never from this ISR-cacheable prop.
  listPricePaise: number;
  formattedPrice: string;
}

export function RecordingBuyButton({
  recordingId,
  formattedPrice,
}: Readonly<BuyButtonProps>) {
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleBuy() {
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/recordings/${recordingId}/purchase`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) {
        setMessage(body.error ?? "Could not start checkout");
        setStatus("error");
        return;
      }

      const ok = await loadScript(
        "https://checkout.razorpay.com/v1/checkout.js",
      );
      if (!ok || !window.Razorpay || !process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID) {
        setMessage("Payment gateway unavailable. Please retry shortly.");
        setStatus("error");
        return;
      }

      const options = buildCheckoutOptions({
        keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        // Gateway-authoritative: the order was just minted (or resumed) for
        // body.data.amount. The page's listPricePaise can lag behind a
        // listing-price update inside the 120s ISR window, and Razorpay
        // rejects checkout when amount ≠ order amount.
        amount: body.data.amount,
        currency: body.data.currency,
        name: "Familiarise Recordings",
        description: body.data.description ?? "Recording purchase",
        orderId: body.data.orderId,
        prefill: {},
        theme: { color: "#6366f1" },
        onDismiss: () => {
          setStatus("idle");
          setMessage("Checkout closed — nothing was charged.");
        },
        handler: () => {
          // Entitlement is written by the capture webhook, which may land a
          // beat after this client callback — don't promise instant access.
          setStatus("idle");
          setMessage(
            "Payment successful! Your recording will appear in your dashboard library within a few minutes.",
          );
        },
      });
      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch {
      setMessage("Something went wrong. Please try again.");
      setStatus("error");
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleBuy}
        disabled={status === "loading"}
        className="w-full rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {status === "loading"
          ? "Opening checkout…"
          : `Buy for ${formattedPrice}`}
      </button>
      {message && (
        <p
          className={`text-sm ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
