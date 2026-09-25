import { permanentRedirect } from "next/navigation";

/** #1771 K-2 — the hub has no body of its own; it opens on Payments. */
export default function AdminMoneyPage() {
  permanentRedirect("/dashboard/admin/money/payments");
}
