"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { loadScript, reportPaymentsError } from "@/app/checkout/plans/utils";
import { useCheckoutFlags } from "@/app/checkout/components/CheckoutFlags";
import { buildCheckoutOptions } from "@/lib/payments/client/checkout-options";
import { fetchWithIdentity } from "@/lib/auth/identity-header";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import { useSession } from "@/lib/auth-client";
import { BuyerFileList } from "@/components/digital-products/BuyerFileList";
import type {
  BuyerFile,
  RemovedBuyerFile,
} from "@/lib/digital-products/buyer-files";
import { ownProductNotice } from "@/lib/digital-products/constants";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { DigitalProductQuote } from "@/lib/payments/pricing/digital-product-price";

export type ProductViewer =
  | { kind: "signed-out" }
  | { kind: "owner" }
  | {
      kind: "buyer";
      name?: string;
      email?: string;
      /** Set when an earlier purchase of this product was refunded. */
      refundedAt?: string | null;
    }
  | {
      kind: "owned";
      libraryHref: string | null;
      free: boolean;
      files: BuyerFile[];
      removed: RemovedBuyerFile[];
    };

const orderSchema = z.object({
  data: z.object({
    purchaseId: z.string(),
    orderId: z.string(),
    amount: z.number(),
    currency: z.string(),
    customerId: z.string().optional(),
  }),
});
const purchaseStatusSchema = z.object({
  data: z.object({
    status: z.enum(["PENDING", "SUCCEEDED", "FAILED", "REFUNDED"]),
  }),
});
type PurchaseStatus = z.infer<typeof purchaseStatusSchema>["data"]["status"];

const POLL_FIRST_MS = 1_000;
const POLL_MAX_MS = 5_000;
const CONFIRM_BUDGET_MS = 60_000;
/** Re-asks Razorpay this often; verify shares the 10-per-minute money limiter. */
const REVERIFY_MS = 15_000;
const RAZORPAY_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readStatus(
  url: string,
  init?: RequestInit,
): Promise<PurchaseStatus | null> {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) return null;
  const parsed = purchaseStatusSchema.safeParse(await res.json());
  return parsed.success ? parsed.data.data.status : null;
}

const settledStatus = (s: PurchaseStatus | null) =>
  s === "SUCCEEDED" || s === "REFUNDED";

/**
 * Ask the server to check Razorpay at once, then poll with backoff for up to a
 * minute, re-checking Razorpay now and then. FAILED is not final here: an
 * earlier declined attempt on the same order marks it FAILED before the
 * successful retry's capture lands.
 */
async function confirmPurchase(purchaseId: string): Promise<PurchaseStatus> {
  const path = `/api/digital-products/purchases/${encodeURIComponent(purchaseId)}`;
  const verify = () => readStatus(`${path}/verify`, { method: "POST" });
  const deadline = Date.now() + CONFIRM_BUDGET_MS;
  let lastVerify = Date.now();
  let status = await verify();
  let delay = POLL_FIRST_MS;
  while (!settledStatus(status) && Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(delay * 1.5, POLL_MAX_MS);
    if (Date.now() - lastVerify >= REVERIFY_MS) {
      lastVerify = Date.now();
      status = await verify();
    } else {
      status = await readStatus(path);
    }
  }
  return status ?? "PENDING";
}

function PriceBreakdown({ quote }: Readonly<{ quote: DigitalProductQuote }>) {
  if (quote.basePaise === null || quote.taxPaise === null) {
    return (
      <p className="text-xs text-muted-foreground">
        Total of your unfinished checkout, taxes included
      </p>
    );
  }
  if (quote.taxPaise === 0) {
    return <p className="text-xs text-muted-foreground">No GST applies</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      {formatCurrencyAmount(quote.basePaise, "INR")} +{" "}
      {formatCurrencyAmount(quote.taxPaise, "INR")} GST
    </p>
  );
}

/** Buy, claim or download a digital product; the page decides who the viewer is. */
export function ProductPurchasePanel({
  productId,
  slug,
  title,
  quote,
  viewer,
}: Readonly<{
  productId: string;
  slug: string;
  title: string;
  /** Null for a free product; the server derives it as the purchase route would charge. */
  quote: DigitalProductQuote | null;
  viewer: ProductViewer;
}>) {
  const router = useRouter();
  const { data: session } = useSession();
  const signedIn = Boolean(session?.user);
  // A cached signed-out render can outlive the sign-in redirect; re-render on the server.
  useEffect(() => {
    if (viewer.kind === "signed-out" && signedIn) router.refresh();
  }, [viewer.kind, signedIn, router]);
  const { toast } = useToast();
  const { emiEnabled } = useCheckoutFlags();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** A purchase checkout reported paid that is not confirmed yet. */
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const isFree = quote === null;
  const priceText = quote
    ? formatCurrencyAmount(quote.totalPaise, "INR")
    : "Free";

  const failed = (description: string) =>
    toast({
      title: "That didn't go through",
      description,
      variant: "destructive",
    });

  const settle = async (purchaseId: string) => {
    setBusy(true);
    setConfirming(true);
    setUnconfirmed(null);
    const status = await confirmPurchase(purchaseId).catch(
      (): PurchaseStatus => "PENDING",
    );
    setConfirming(false);
    setBusy(false);
    if (status === "PENDING" || status === "FAILED") setUnconfirmed(purchaseId);
    if (status === "SUCCEEDED") {
      toast({ title: "It's yours", description: "Your files are ready." });
      router.refresh();
    } else if (status === "PENDING" || status === "FAILED") {
      // Checkout reported success, so the sweep settles a capture the webhook missed.
      toast({
        title: "Payment received, still confirming",
        description:
          "It will appear in your library within a few minutes. You won't be charged twice.",
      });
      return;
    } else {
      failed(
        "This payment was refunded, so the product is not in your library. The money goes back to your original payment method.",
      );
    }
  };

  const claim = async () => {
    setBusy(true);
    try {
      const res = await fetchWithIdentity(
        `/api/digital-products/${encodeURIComponent(productId)}/claim`,
        { method: "POST" },
      );
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        failed(errorMessageFromBody(body, "Couldn't add it to your library."));
        router.refresh();
        return;
      }
      toast({ title: "Added to your library" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const buy = async () => {
    setBusy(true);
    let opened = false;
    try {
      const res = await fetchWithIdentity(
        `/api/digital-products/${encodeURIComponent(productId)}/purchase`,
        { method: "POST" },
      );
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        failed(errorMessageFromBody(body, "Couldn't start the payment."));
        router.refresh();
        return;
      }
      const order = orderSchema.parse(body).data;
      const loaded = await loadScript(RAZORPAY_SCRIPT).catch(() => false);
      if (!loaded || !window.Razorpay) {
        failed(
          "The payment window couldn't load. Disable ad blockers and try again.",
        );
        return;
      }
      const rzp = new window.Razorpay(
        buildCheckoutOptions({
          keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
          orderId: order.orderId,
          amount: order.amount,
          currency: order.currency,
          name: "Familiarise",
          description: title,
          customerId: order.customerId,
          hideEmi: !emiEnabled,
          theme: { color: "#2563EB" },
          prefill:
            viewer.kind === "buyer"
              ? { name: viewer.name, email: viewer.email }
              : undefined,
          handler: () => void settle(order.purchaseId),
          onDismiss: () => setBusy(false),
        }),
      );
      let reported = false;
      rzp.on("payment.failed", ({ error }) => {
        // Razorpay's own sentence already says what to try next.
        toast({
          title: "The payment didn't go through",
          description:
            error.description?.trim() ||
            "You can try again or choose another payment method.",
          variant: "destructive",
        });
        // One event per checkout, grouped by the gateway's code.
        if (reported) return;
        reported = true;
        Sentry.captureMessage("digital product payment failed", {
          level: "warning",
          tags: { subsystem: "payments", gatewayCode: error.code },
          fingerprint: [
            "digital-product-payment-failed",
            error.code ?? "unknown",
          ],
          extra: { reason: error.reason },
        });
      });
      rzp.open();
      opened = true;
    } catch (error) {
      reportPaymentsError(error);
      failed("Couldn't start the payment. Please try again.");
    } finally {
      if (!opened) setBusy(false);
    }
  };

  if (viewer.kind === "owned") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          <span>You own this. Downloads never expire.</span>
        </div>
        {viewer.libraryHref && (
          <Button asChild className="w-full">
            <Link href={viewer.libraryHref}>Open library</Link>
          </Button>
        )}
        <BuyerFileList
          productId={productId}
          files={viewer.files}
          removed={viewer.removed}
          free={viewer.free}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-2xl font-semibold">{priceText}</p>
        {quote && <PriceBreakdown quote={quote} />}
      </div>
      {viewer.kind === "signed-out" && (
        <Button asChild className="w-full">
          <Link
            href={`/auth/signin?callbackUrl=${encodeURIComponent(`/explore/products/${slug}`)}`}
          >
            {isFree ? "Sign in to get it free" : "Sign in to buy"}
          </Link>
        </Button>
      )}
      {viewer.kind === "owner" && (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
          {ownProductNotice(isFree)}
        </p>
      )}
      {viewer.kind === "buyer" && viewer.refundedAt && (
        <p
          role="status"
          className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground"
        >
          Your earlier purchase was refunded on{" "}
          {new Date(viewer.refundedAt).toLocaleDateString("en-IN", {
            dateStyle: "medium",
            timeZone: "Asia/Kolkata",
          })}
          , so it is no longer in your library. You can buy it again.
        </p>
      )}
      {viewer.kind === "buyer" && (
        <Button
          className="w-full"
          disabled={busy}
          onClick={() => void (isFree ? claim() : buy())}
        >
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {confirming && "Confirming payment…"}
          {!confirming && (isFree ? "Get for free" : `Buy for ${priceText}`)}
        </Button>
      )}
      {confirming && (
        <p role="status" className="text-xs text-muted-foreground">
          Confirming your payment. This can take up to a minute — you won&apos;t
          be charged twice.
        </p>
      )}
      {!confirming && unconfirmed && (
        <Button
          variant="outline"
          className="w-full"
          onClick={() => void settle(unconfirmed)}
        >
          Check again
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        {isFree
          ? "Free to download once it's in your library."
          : "One payment, lifetime access. Refundable until your first download."}
      </p>
    </div>
  );
}
