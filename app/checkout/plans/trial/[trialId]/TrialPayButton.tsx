"use client";

import { CreditCard } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { isExternalPayHref } from "@/lib/payments/pay-link-href";

/**
 * Hands off to the trial's pay target. #1775 P-1 — a Razorpay order resolves
 * to our pay page (`/checkout/pay/<paymentId>`), which opens the existing
 * order in the gateway sheet; only a hosted https link opens a new tab.
 */
export function TrialPayButton({ href }: { href: string }) {
  const router = useRouter();
  return (
    <Button
      className="w-full"
      size="lg"
      onClick={() => {
        if (isExternalPayHref(href)) {
          window.open(href, "_blank", "noopener,noreferrer");
          return;
        }
        router.push(href);
      }}
    >
      <CreditCard className="mr-2 h-4 w-4" />
      Pay to confirm
    </Button>
  );
}
