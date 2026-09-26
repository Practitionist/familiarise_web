import { requireBackofficePage } from "@/lib/auth-guard";
import { VerificationPageClient } from "./VerificationPageClient";

/** #1527 — one verification queue (was split across Users and Moderation). */
export default async function BackofficeVerificationPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("users.verify", (await params).tree);
  return <VerificationPageClient />;
}
