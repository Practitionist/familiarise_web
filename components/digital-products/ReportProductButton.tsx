"use client";

import { Flag } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { useToast } from "@/hooks/use-toast";
import { errorMessageFromBody } from "@/lib/fetch-helpers";

/** Flag a product for the moderation team; any signed-in user may. */
export function ReportProductButton({
  productId,
}: Readonly<{ productId: string }>) {
  const { toast } = useToast();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          <Flag className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Report this product
        </Button>
      }
      title="Report this product"
      description="Tell us what is wrong: harmful files, stolen content or something that isn't as described. Our team reviews every report."
      confirmLabel="Send report"
      requireReason={{
        label: "What's wrong?",
        minLength: 10,
        placeholder: "At least 10 characters",
      }}
      onConfirm={async ({ reason }) => {
        const res = await fetch(
          `/api/digital-products/${encodeURIComponent(productId)}/report`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason }),
          },
        );
        if (!res.ok) {
          throw new Error(
            errorMessageFromBody(
              await res.json().catch(() => null),
              "Couldn't send the report. Please try again.",
            ),
          );
        }
        toast({ title: "Report sent", description: "Thanks for telling us." });
      }}
    />
  );
}
