import { notFound } from "next/navigation";
import { ENABLE_TDS_ADMIN_VIEW } from "@/lib/feature-flags";
import TdsPageClient from "./TdsPageClient";
import { requireBackofficePage } from "@/lib/auth-guard";

// #863 — thin admin surface over the existing /api/admin/tds endpoint. Gated on
// the same flag as the API (404 when off), so the page and endpoint appear and
// disappear together. Auth is enforced by the admin route-group layout and the
// endpoint's requirePrivilegedAuth. No Form 26Q/140 export UI — the CBDT codes
// are unconfirmed; this is read-only summary + breakdown.
export default async function AdminTdsPage() {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("tds.read");
  if (!ENABLE_TDS_ADMIN_VIEW) notFound();
  return <TdsPageClient />;
}
