import Link from "next/link";

/**
 * #1675 — the line under a "Refund failed" badge. FAILED is terminal (no
 * money moved, the reconcile sweep never re-drives it); staff re-issue it by
 * hand from the refunds queue, so the only next step here is to reach them.
 */
export function FailedRefundNote({
  status,
  amountText,
  supportHref,
}: {
  status: string;
  amountText: string;
  supportHref: string;
}) {
  if (status !== "FAILED") return null;
  return (
    <span className="block mt-1 max-w-[260px] whitespace-normal text-xs text-muted-foreground">
      We couldn&apos;t return {amountText} to your original payment method.
      Nothing was charged again. Our team re-issues failed refunds by hand
      within 3 working days —{" "}
      <Link
        href={supportHref}
        className="font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground"
      >
        Contact support
      </Link>{" "}
      to follow up.
    </span>
  );
}
