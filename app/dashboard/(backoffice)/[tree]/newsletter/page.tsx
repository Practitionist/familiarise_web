import { NewsletterManagement } from "@/components/admin/NewsletterManagement";
import { requireBackofficePage } from "@/lib/auth-guard";

/** The newsletter subscriber list. */
export default async function BackofficeNewsletterPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("newsletter.manage", (await params).tree);
  return <NewsletterManagement />;
}
