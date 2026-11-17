import { formatOperatorInstant } from "@/lib/time/operator-zone";
import type { PaymentDigitalProductPurchase } from "@/types/payments";

/** How much of a digital product sale the buyer took; shown, never enforced. */
export function downloadEvidenceText(
  purchase: PaymentDigitalProductPurchase,
): string {
  const count = purchase._count.downloads;
  if (count === 0 || !purchase.firstDownloadedAt) return "Not downloaded yet";
  const first = formatOperatorInstant(purchase.firstDownloadedAt);
  return `Downloaded ${count} ${count === 1 ? "time" : "times"}, first at ${first}`;
}

export function DownloadEvidence({
  purchase,
}: Readonly<{ purchase: PaymentDigitalProductPurchase }>) {
  return (
    <p className="text-sm">
      <span className="font-medium">{purchase.product.title}</span>
      {" · "}
      {downloadEvidenceText(purchase)}
    </p>
  );
}
