"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Download, Loader2 } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { loadScript, reportPaymentsError } from "@/app/checkout/plans/utils";
import { useCheckoutFlags } from "@/app/checkout/components/CheckoutFlags";
import { buildCheckoutOptions } from "@/lib/payments/client/checkout-options";
import { fetchWithIdentity } from "@/lib/auth/identity-header";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import { formatFileSize } from "@/lib/documents/document-utils";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { DigitalProductQuote } from "@/lib/payments/pricing/digital-product-price";

export type ProductViewer =
  | { kind: "signed-out" }
  | { kind: "owner" }
  | { kind: "buyer"; name?: string; email?: string }
  | { kind: "owned"; libraryHref: string | null };

interface PanelFile {
  id: string;
  originalName: string;
  sizeBytes: number;
}

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

const POLL_INTERVAL_MS = 2_000;
const POLL_ATTEMPTS = 8;
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

/**
 * Poll the purchase the webhook settles, then ask the server to check Razorpay
 * itself. FAILED is not final here: an earlier declined attempt on the same
 * order marks it FAILED before the successful retry's capture lands.
 */
async function confirmPurchase(purchaseId: string): Promise<PurchaseStatus> {
  const path = `/api/digital-products/purchases/${encodeURIComponent(purchaseId)}`;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const status = await readStatus(path);
    if (status === "SUCCEEDED" || status === "REFUNDED") return status;
    await sleep(POLL_INTERVAL_MS);
  }
  return (await readStatus(`${path}/verify`, { method: "POST" })) ?? "PENDING";
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
  files,
}: Readonly<{
  productId: string;
  slug: string;
  title: string;
  /** Null for a free product; the server derives it as the purchase route would charge. */
  quote: DigitalProductQuote | null;
  viewer: ProductViewer;
  files: PanelFile[];
}>) {
  const router = useRouter();
  const { toast } = useToast();
  const { emiEnabled } = useCheckoutFlags();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
    setConfirming(true);
    const status = await confirmPurchase(purchaseId).catch(
      (): PurchaseStatus => "PENDING",
    );
    setConfirming(false);
    setBusy(false);
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
    } else {
      failed("The payment was not completed. You have not been charged.");
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
      rzp.on("payment.failed", () => {
        failed("Your card was declined or the payment timed out.");
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
        <ul className="divide-y rounded-md border text-sm">
          {files.map((file) => (
            <li key={file.id} className="flex items-center gap-2 p-2.5">
              <span className="min-w-0 flex-1 truncate">
                {file.originalName}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatFileSize(file.sizeBytes)}
              </span>
              <Button asChild size="sm" variant="ghost" className="h-7 w-7 p-0">
                <a
                  href={`/api/digital-products/${encodeURIComponent(productId)}/assets/${encodeURIComponent(file.id)}/download`}
                  aria-label={`Download ${file.originalName}`}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                </a>
              </Button>
            </li>
          ))}
        </ul>
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
          This is your product. Buyers see the button here.
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
      <p className="text-xs text-muted-foreground">
        {isFree
          ? "Free to download once it's in your library."
          : "One payment, lifetime access. Refundable until your first download."}
      </p>
    </div>
  );
}
